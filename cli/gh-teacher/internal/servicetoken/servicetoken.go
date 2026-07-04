// Package servicetoken is the service-token substrate seam: provisioning,
// validating, and reading the CLASSROOM50_SERVICE_TOKEN repo-level Actions
// secret that the collect-scores workflow consumes. It owns the
// init-type-free core shared by `gh teacher init` (via package main's
// provisionServiceToken orchestrator) and the `rotate-service-token`
// command (NewRotateCmd). It depends only on the internal/* substrate
// seams (cliutil, configrepo, githubapi) plus the shared ghauth helper,
// never on package main. The *initSummary-typed init step
// (provisionServiceToken) stays in package main and calls into this seam.
package servicetoken

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/crypto/nacl/box"
	"golang.org/x/term"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// readHiddenLine reads one line with echo off so the PAT never
// appears on screen.
func readHiddenLine(f *os.File) (string, error) {
	b, err := term.ReadPassword(int(f.Fd()))
	return string(b), err
}

// SecretName: the repo-level Actions secret collect-scores.yaml consumes.
// Hardcoded because it appears verbatim in the workflow YAML.
const SecretName = "CLASSROOM50_SERVICE_TOKEN"

// EnvServiceToken: env var carrying the token. No --token flag is offered;
// flag values leak via shell history, process listings, and CI logs.
const EnvServiceToken = "CLASSROOM50_SERVICE_TOKEN"

// ReadToken returns the token from env or stdin:
//   - env set: use it (CI/scripted)
//   - env unset, stdin piped: read one line
//   - env unset, stdin + stderr both TTY: hidden-echo prompt
//   - env unset, stderr not a TTY: error (can't safely prompt under
//     tee/script)
func ReadToken(cmd *cobra.Command) ([]byte, error) {
	if v := strings.TrimSpace(os.Getenv(EnvServiceToken)); v != "" {
		return []byte(v), nil
	}

	stdinIsTTY := ghauth.IsCharDevice(os.Stdin)
	if !stdinIsTTY {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return nil, fmt.Errorf("read token from stdin: %w", err)
			}
			return nil, errors.New("empty token piped on stdin")
		}
		v := strings.TrimSpace(scanner.Text())
		if v == "" {
			return nil, errors.New("empty token piped on stdin")
		}
		return []byte(v), nil
	}

	if !ghauth.IsCharDevice(os.Stderr) {
		return nil, fmt.Errorf("can't prompt for the service token without an interactive terminal on stderr; set %s in the environment", EnvServiceToken)
	}

	// Prompt on stderr so `> file` on stdout doesn't capture it.
	_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "%s (input hidden, ends with Enter): ", EnvServiceToken)
	v, err := readHiddenLine(os.Stdin)
	_, _ = fmt.Fprintln(cmd.ErrOrStderr())
	if err != nil {
		return nil, fmt.Errorf("read token from terminal: %w", err)
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, errors.New("empty token entered")
	}
	return []byte(v), nil
}

// SecretExists reports whether the CLASSROOM50_SERVICE_TOKEN Actions
// secret is already provisioned on <owner>/<repo>. GitHub never returns a
// secret's value (write-only), but GET .../secrets/{name} returns 200 when
// it exists and 404 when not — enough to skip the interactive prompt on a
// re-run. A non-404 error is reported as "unknown" (false, err) so callers
// can decide; init treats unknown as "not configured" and proceeds to
// prompt rather than silently skipping.
func SecretExists(client githubapi.Client, owner, repo string) (bool, error) {
	path := fmt.Sprintf("repos/%s/%s/actions/secrets/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(SecretName))
	if err := client.Get(path, nil); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// ValidateToken confirms a freshly-supplied service token can actually do
// what the pipeline needs: read AND write repository contents in the org,
// AND read the org's members. Reading back the gradebook (collect-scores)
// and pushing submit/* tags to regrade (regrade.yaml) both require Contents
// access — collect reads, regrade writes — so the one shared token must
// hold Contents: Read and write. Collection is also TEAM-driven: it lists
// the classroom team's members (GET /orgs/{org}/teams/{slug}/members) to
// derive the (student, assignment) pairs, which needs the org-level
// Members: Read permission — a permission NOT implied by any repository
// scope. It builds a client authenticated AS the supplied token, reads the
// config repo (catching a wrong/zeroed resource owner, a still-pending
// fine-grained PAT, or an expired/revoked token), asserts the repo's
// effective `permissions.push` so a read-only PAT is rejected here, and
// probes the org members endpoint so a Members-less PAT is caught here
// rather than surfacing months later as an opaque collect-scores 403.
// Returns a descriptive, actionable error on failure.
func ValidateToken(token []byte, org string) error {
	return ValidateTokenVerbose(token, org, io.Discard)
}

// ValidateTokenVerbose is ValidateToken with a writer for advisory notes. When
// the org-members probe is INCONCLUSIVE (401/5xx/timeout after a proven-live
// repo read), validation still passes (fail-open), but a warning is written to
// `out` so the teacher knows the Members: Read scope wasn't positively
// confirmed and should run the `probe-token` workflow before relying on the
// nightly collect — otherwise a Members-less token sits latent until the cron
// 403s and aborts the whole run.
func ValidateTokenVerbose(token []byte, org string, out io.Writer) error {
	tokenClient, err := githubapi.NewClient(githubapi.ClientOptions{
		AuthToken: string(token),
	})

	if err != nil {
		return fmt.Errorf("build token client: %w", err)
	}
	return validateTokenWithClient(tokenClient, org, out)
}

// validateTokenWithClient is ValidateToken's testable core: it reads the
// config repo with an already-built client (authenticated as the token
// under test), asserts the token can write contents, then probes the org
// members endpoint, mapping each failure mode to an actionable error.
//
// GET /repos/{owner}/{repo} returns a `permissions` object reflecting the
// AUTHENTICATED token's effective access on the repo (`push` is true only
// when the token can write contents). We assert it so a Contents: read-only
// PAT — which can read the gradebook but cannot push the submit/* tags a
// regrade needs — is rejected at configuration time. The read itself also
// exercises Contents: read (what collect-scores does on student repos).
//
// GET /orgs/{org}/members then exercises the org-level Members: Read
// permission that team-driven collection needs (it lists the classroom
// team's members). That permission is not implied by any Contents scope. A
// 403/404 here is a definitive scope gap and is rejected; any other result
// (401, 5xx, rate-limit, timeout) is treated as inconclusive and allowed to
// proceed, since the repo read already proved the token live — blocking a
// valid token on this second round-trip's flakiness would be worse than the
// cron-time 403 the runtime already handles. The probe-token.yaml workflow
// is the exhaustive post-provision signal.
func validateTokenWithClient(tokenClient githubapi.Client, org string, out io.Writer) error {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(configrepo.ConfigRepoName))
	var repo struct {
		Permissions struct {
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	if err := tokenClient.Get(path, &repo); err != nil {
		switch {
		case cliutil.IsHTTPStatus(err, http.StatusUnauthorized):
			return fmt.Errorf("the supplied token is invalid, expired, or revoked (401). Create a fresh fine-grained PAT and try again")
		case cliutil.IsHTTPStatus(err, http.StatusNotFound), cliutil.IsHTTPStatus(err, http.StatusForbidden):
			return fmt.Errorf("the supplied token can't read %s/%s. Create a fine-grained PAT with Resource owner = %q, Repository access = All repositories, and Repository permissions -> Contents: Read and write AND Actions: Read and write (regrade re-runs autograde workflow runs). If your org requires PAT approval and you are not an org owner, an owner must approve it first (owners' tokens are auto-approved). Underlying error: %v", org, configrepo.ConfigRepoName, org, err)
		default:
			return fmt.Errorf("couldn't verify the token against %s/%s: %w", org, configrepo.ConfigRepoName, err)
		}
	}
	// The token can read the repo, but regrade needs to push
	// submit/* tags to student repos — Contents: write. A read-only PAT
	// reports permissions.push == false here; reject it with the same
	// actionable fix as a no-access token.
	if !repo.Permissions.Push {
		return fmt.Errorf("the supplied token can read %s/%s but lacks write access (Contents: write) — collecting scores needs read, but regrading needs to push submit/* tags to student repos. Re-create the fine-grained PAT with Resource owner = %q, Repository access = All repositories, and Repository permissions -> Contents: Read and write AND Actions: Read and write (regrade re-runs student autograde workflow runs)", org, configrepo.ConfigRepoName, org)
	}

	// Contents is proven, but collection is TEAM-driven: it lists the
	// classroom team's members to derive the (student, assignment) pairs,
	// which needs the org-level Members: Read permission. That permission is
	// NOT implied by any repository scope, so a token with only Contents
	// passes every check above yet 403s on the very first API call the
	// collect-scores workflow makes. Probe GET /orgs/{org}/members (the same
	// Members: Read permission the team-members endpoint requires, but not
	// dependent on a specific team existing at init time) so a Members-less
	// PAT is rejected here instead of weeks later in a cron run.
	// NOTE ON FAIL-OPEN: this probe is a proxy for the team-members read
	// collection actually makes; a definitive scope gap surfaces as 403/404
	// and is rejected here, but any OTHER result (401, 5xx, rate-limit,
	// timeout) is treated as INCONCLUSIVE and allowed to proceed. The repo
	// read above already proved the token is live and can write, so a 401 or
	// transient failure on this second, independent round-trip is far more
	// likely GitHub-side flakiness than a real problem — blocking a valid
	// token on it would be a worse failure than the cron-time 403 the runtime
	// already handles. The `probe-token.yaml` workflow is the exhaustive,
	// side-effect-checked signal; this is the cheap provisioning-time guard.
	membersPath := fmt.Sprintf("orgs/%s/members?per_page=1", url.PathEscape(org))
	if err := tokenClient.Get(membersPath, nil); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) || cliutil.IsHTTPStatus(err, http.StatusForbidden) {
			return fmt.Errorf("the supplied token can read %s/%s but can't read the org's members — collecting scores is team-driven and lists the classroom team's members, which needs the org-level Members permission. Re-create the fine-grained PAT with Resource owner = %q and add Organization permissions -> Members: Read (this is a separate section from Repository permissions; it appears only once the org is selected as Resource owner). Underlying error: %v", org, configrepo.ConfigRepoName, org, err)
		}
		// Inconclusive (401 after a 200 repo read, 5xx, rate-limit, timeout):
		// proceed rather than reject a token the repo read just proved valid,
		// but WARN — the Members: Read scope the nightly collect needs was not
		// positively confirmed, and an unconfirmed Members-less token 403s at
		// collect time and aborts the whole run. Point the teacher at the
		// exhaustive probe-token workflow.
		_, _ = fmt.Fprintf(out, "Warning: couldn't confirm the token's Organization -> Members: Read scope (%v). Proceeding, since the repo read proved the token live, but if it in fact lacks Members: Read, the nightly collect will 403 and skip. Run the `probe-token` workflow to verify all scopes before the first collect.\n", err)
	}
	return nil
}

// ProvisionSecret sealbox-encrypts `token` against the repo's Actions
// public key and uploads it as the repo-level CLASSROOM50_SERVICE_TOKEN
// secret. Repo-level (not org-level) keeps the secret invisible to other
// repos in the org. Idempotent (PUT replaces in place). Shared by `init`
// and `rotate-service-token`.
func ProvisionSecret(client githubapi.Client, out io.Writer, owner, repo string, token []byte, verb string) error {
	keyPath := fmt.Sprintf("repos/%s/%s/actions/secrets/public-key",
		url.PathEscape(owner), url.PathEscape(repo))
	var keyResp struct {
		KeyID string `json:"key_id"`
		Key   string `json:"key"`
	}
	if err := client.Get(keyPath, &keyResp); err != nil {
		return fmt.Errorf("GET %s: %w", keyPath, err)
	}

	pubKeyBytes, err := base64.StdEncoding.DecodeString(keyResp.Key)
	if err != nil {
		return fmt.Errorf("decode repo public key: %w", err)
	}
	if len(pubKeyBytes) != 32 {
		return fmt.Errorf("repo public key wrong size: got %d, want 32", len(pubKeyBytes))
	}
	var pubKey [32]byte
	copy(pubKey[:], pubKeyBytes)

	encrypted, err := box.SealAnonymous(nil, token, &pubKey, rand.Reader)
	if err != nil {
		return fmt.Errorf("sealbox encrypt: %w", err)
	}
	encryptedB64 := base64.StdEncoding.EncodeToString(encrypted)

	body, err := json.Marshal(struct {
		EncryptedValue string `json:"encrypted_value"`
		KeyID          string `json:"key_id"`
	}{
		EncryptedValue: encryptedB64,
		KeyID:          keyResp.KeyID,
	})
	if err != nil {
		return fmt.Errorf("encode secret body: %w", err)
	}
	putPath := fmt.Sprintf("repos/%s/%s/actions/secrets/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(SecretName))
	resp, err := client.Request(http.MethodPut, putPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("PUT %s: %w", putPath, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	// 201 = secret created, 204 = secret updated; any other 2xx means
	// the upload didn't land as expected. Assert it (matching the
	// status-check convention of the sibling write helpers) so a silent
	// non-write doesn't get reported as a stored token.
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("PUT %s: unexpected status %d", putPath, resp.StatusCode)
	}

	_, _ = fmt.Fprintf(out, "%s/%s: %s %s\n", owner, repo, verb, SecretName)
	return nil
}

// NewRotateCmd re-runs just the secret-provisioning step of `init` (PAT
// expiry, incident response).
func NewRotateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rotate-service-token <org>",
		Short: "Rotate the CLASSROOM50_SERVICE_TOKEN repo secret",
		Long: "Re-uploads the CLASSROOM50_SERVICE_TOKEN repo-level\n" +
			"Actions secret on <org>/classroom50 with a freshly-supplied\n" +
			"PAT value. The token is read from the\n" +
			"CLASSROOM50_SERVICE_TOKEN environment variable, falling\n" +
			"back to a hidden stdin prompt when run interactively.\n\n" +
			"The token is validated against the org before it's stored\n" +
			"(it must be able to read AND write repository contents:\n" +
			"collect-scores reads, regrade pushes submit/* tags; and it\n" +
			"must be able to read the org's members: collection is\n" +
			"team-driven and lists the classroom team). So a\n" +
			"misconfigured PAT is caught here rather than via a failed\n" +
			"collect-scores or regrade run.\n\n" +
			"Required fine-grained PAT scopes: Repository permissions ->\n" +
			"Contents: Read and write AND Actions: Read and write (Metadata:\n" +
			"Read is auto-included), and Organization permissions -> Members:\n" +
			"Read (a separate section shown only once the org is the Resource\n" +
			"owner).\n\n" +
			"Idempotent: the repo secret is replaced in place.",
		Example: "  CLASSROOM50_SERVICE_TOKEN=github_pat_xxx gh teacher rotate-service-token cs50-fall-2026\n" +
			"  gh teacher rotate-service-token cs50-fall-2026   # interactive prompt",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			if org == "" {
				return errors.New("org must not be empty")
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()

			// Refuse to rotate on an org without classroom50 — the
			// user probably mistyped.
			repoPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), configrepo.ConfigRepoName)
			if err := client.Get(repoPath, nil); err != nil {
				if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
					return fmt.Errorf("%s/%s does not exist; run `gh teacher init %s` first", org, configrepo.ConfigRepoName, org)
				}
				return fmt.Errorf("GET %s: %w", repoPath, err)
			}

			token, err := ReadToken(cmd)
			if err != nil {
				return err
			}
			// Validate before storing: catch a bad PAT now, not via a
			// failed collect-scores workflow weeks later. Verbose so an
			// inconclusive Members-scope probe warns the teacher.
			if err := ValidateTokenVerbose(token, org, out); err != nil {
				return fmt.Errorf("service token validation failed: %w", err)
			}
			return ProvisionSecret(client, out, org, configrepo.ConfigRepoName, token, "rotated")
		},
	}
	return cmd
}
