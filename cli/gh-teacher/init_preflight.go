package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/servicetoken"
	"github.com/foundation50/gh-teacher/internal/ui"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// preflightStatus is the outcome of a single preflight check, aliased to
// ui.Status so the renderer owns the glyph mapping. The string values
// ("ok"/"warn"/"fail") preserve the --json contract.
type preflightStatus = ui.Status

const (
	preflightOK   = ui.StatusOK
	preflightWarn = ui.StatusWarn
	preflightFail = ui.StatusFail
)

// preflightCheck is one read-only check before init mutates the org.
// JSON-serializable (no omitempty) so it embeds in the init summary.
type preflightCheck struct {
	Name   string          `json:"name"`
	Status preflightStatus `json:"status"`
	Detail string          `json:"detail"`
}

// preflightResult bundles the checks with the org plan (read once here so later
// steps don't re-fetch it) and a convenience `failed` flag.
type preflightResult struct {
	Checks []preflightCheck
	Plan   string
	// SecretExists records whether the token secret is already provisioned, so
	// the provisioning step can skip a duplicate GET.
	SecretExists bool
	Failed       bool
}

// tokenSource describes whether a service token is available (env) or needs a
// prompt — preflight catches the "no token + no interactive terminal" case
// before any mutation, since the prompt otherwise crashes only at the end.
type tokenSource struct {
	envSet     bool
	stdinTTY   bool
	stderrTTY  bool
	stdinPiped bool
}

// runPreflight runs every read-only check and returns the aggregate. Order is
// deliberate: cheap local checks and the single org GET first, so a
// misconfigured run fails fast.
func runPreflight(client githubapi.Client, org string, tok tokenSource) preflightResult {
	var res preflightResult

	// 1. Auth scopes — read X-OAuth-Scopes off a cheap GET; the same call
	// yields the login reused by the ownership check.
	scopeCheck, _, login := checkScopes(client)
	res.Checks = append(res.Checks, scopeCheck)

	// 2 & 3. Org access + plan from a single GET /orgs/{org}.
	accessCheck, plan := checkOrgAccess(client, org)
	res.Plan = plan
	res.Checks = append(res.Checks, accessCheck)
	res.Checks = append(res.Checks, planCheck(org, plan))

	// 4. Org ownership — only an owner can apply the lockdown and create the
	// repo (reuses the login from checkScopes).
	res.Checks = append(res.Checks, checkOwnership(client, org, login))

	// 5. Token availability, UNLESS the secret is already configured (a re-run
	// leaves it untouched). Check the secret first so a re-run on a
	// non-interactive shell isn't falsely blocked. Result carried on the
	// preflight so provisioning doesn't re-fetch it.
	res.SecretExists, _ = servicetoken.SecretExists(client, org, configrepo.ConfigRepoName)
	res.Checks = append(res.Checks, checkTokenAvailability(tok, res.SecretExists))

	for _, c := range res.Checks {
		if c.Status == preflightFail {
			res.Failed = true
		}
	}
	return res
}

// checkScopes confirms the token carries gh-teacher's required scopes, reading
// X-OAuth-Scopes from GET /user and checking each via
// validate.ScopeListSatisfies (honoring GitHub's scope hierarchy — admin:org
// implies read:org). A fine-grained PAT or unknown auth type has no scope
// header, so we warn rather than fail (real ops fail loudly later). Returns the
// check plus the raw scope string and the login (decoded from the same
// response).
func checkScopes(client githubapi.Client) (check preflightCheck, scopes, login string) {
	c := preflightCheck{Name: "auth scopes"}
	resp, err := client.Request(http.MethodGet, "user", nil)
	if err != nil {
		c.Status = preflightWarn
		c.Detail = fmt.Sprintf("couldn't verify OAuth scopes (%v); proceeding — operations needing the classroom scopes will fail with guidance if a scope is missing", err)
		return c, "", ""
	}
	defer func() { _ = resp.Body.Close() }()
	var user struct {
		Login string `json:"login"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&user)
	scopes = resp.Header.Get("X-OAuth-Scopes")
	if scopes == "" {
		c.Status = preflightWarn
		c.Detail = "no X-OAuth-Scopes header (fine-grained PAT or app token); can't verify the classroom scopes up front"
		return c, "", user.Login
	}
	var missing []string
	for _, want := range githubapi.RequiredScopes() {
		if !validate.ScopeListSatisfies(scopes, want) {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 {
		c.Status = preflightFail
		c.Detail = fmt.Sprintf("token is missing OAuth scope(s) %s; run `gh teacher login` to grant them", strings.Join(missing, ", "))
		return c, scopes, user.Login
	}
	c.Status = preflightOK
	c.Detail = fmt.Sprintf("%s present", strings.Join(githubapi.RequiredScopes(), ", "))
	return c, scopes, user.Login
}

// checkOrgAccess confirms GET /orgs/{org} succeeds and returns the plan name
// (empty when the caller lacks billing visibility). Any error is a hard fail
// since every later step needs org access. The read lives in
// githubapi.OrgPlan; this wrapper adds preflight framing and the 404 message.
func checkOrgAccess(client githubapi.Client, org string) (preflightCheck, string) {
	c := preflightCheck{Name: "org access"}
	plan, err := githubapi.OrgPlan(client, org)
	if err != nil {
		c.Status = preflightFail
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			c.Detail = fmt.Sprintf("organization %q not found, or your token can't see it — check the name and that you're a member", org)
		} else {
			c.Detail = fmt.Sprintf("couldn't read organization %q (%v)", org, err)
		}
		return c, ""
	}
	c.Status = preflightOK
	c.Detail = fmt.Sprintf("organization %q is reachable", org)
	return c, plan
}

// planCheck applies the Pages-from-private-repo advisory: a non-Team/Enterprise
// plan can't serve Pages from a private repo. Advisory (warn), never fail. An
// empty plan is treated as OK (can't tell).
func planCheck(org, plan string) preflightCheck {
	c := preflightCheck{Name: "org plan"}
	switch {
	case plan == "":
		c.Status = preflightOK
		c.Detail = "plan not visible to this token; skipping plan check"
	case plansThatSupportPrivatePages[plan]:
		c.Status = preflightOK
		c.Detail = fmt.Sprintf("plan %q supports Pages from a private repo", plan)
	default:
		c.Status = preflightWarn
		c.Detail = fmt.Sprintf("plan %q can't serve Pages from a private repo (needs Team or Enterprise Cloud); the repo is still created but publish-pages may not deploy", plan)
	}
	return c
}

// checkOwnership confirms the authenticated user is an org owner (membership
// role "admin"). Only owners can apply the lockdown, so a member fails up front
// rather than collecting 403s mid-run. A read failure is a warn. The login
// comes from checkScopes, so this doesn't re-fetch /user.
func checkOwnership(client githubapi.Client, org, login string) preflightCheck {
	c := preflightCheck{Name: "org ownership"}
	if login == "" {
		c.Status = preflightWarn
		c.Detail = "couldn't resolve the authenticated user; skipping ownership check"
		return c
	}
	path := fmt.Sprintf("orgs/%s/memberships/%s", url.PathEscape(org), url.PathEscape(login))
	var resp struct {
		Role  string `json:"role"`
		State string `json:"state"`
	}
	if err := client.Get(path, &resp); err != nil {
		c.Status = preflightWarn
		c.Detail = fmt.Sprintf("couldn't read your org membership (%v); proceeding — owner-only steps will fail with guidance if you aren't an owner", err)
		return c
	}
	if resp.Role != "admin" {
		c.Status = preflightFail
		c.Detail = fmt.Sprintf("you are a %q of %q, not an owner; `gh teacher init` needs org-owner rights to lock down member privileges and create the config repo", resp.Role, org)
		return c
	}
	c.Status = preflightOK
	c.Detail = "you are an org owner"
	return c
}

// checkTokenAvailability catches "no token AND no way to prompt" before init
// mutates anything. ReadToken reads env, else piped stdin, else a hidden stderr
// prompt; if env is unset, stdin is a TTY, and stderr is NOT a TTY, the prompt
// errors — but only after the org is configured. Surfacing it here fails fast.
func checkTokenAvailability(tok tokenSource, secretExists bool) preflightCheck {
	c := preflightCheck{Name: "service token"}
	switch {
	case secretExists && !tok.envSet:
		c.Status = preflightOK
		c.Detail = "already configured (re-run leaves it untouched)"
	case tok.envSet:
		c.Status = preflightOK
		c.Detail = servicetoken.EnvServiceToken + " is set"
	case tok.stdinPiped:
		c.Status = preflightOK
		c.Detail = "token will be read from piped stdin"
	case tok.stdinTTY && tok.stderrTTY:
		c.Status = preflightOK
		c.Detail = "token will be prompted interactively"
	default:
		c.Status = preflightFail
		c.Detail = fmt.Sprintf("no %s set and no interactive terminal to prompt on; set %s in the environment before re-running", servicetoken.EnvServiceToken, servicetoken.EnvServiceToken)
	}
	return c
}

// currentTokenSource snapshots the token/TTY environment. stdinPiped means
// stdin is a pipe/file (readable as one line), distinct from stdinTTY.
func currentTokenSource() tokenSource {
	envSet := strings.TrimSpace(os.Getenv(servicetoken.EnvServiceToken)) != ""
	stdinTTY := ghauth.IsCharDevice(os.Stdin)
	return tokenSource{
		envSet:     envSet,
		stdinTTY:   stdinTTY,
		stderrTTY:  ghauth.IsCharDevice(os.Stderr),
		stdinPiped: !stdinTTY,
	}
}

// renderPreflight prints the preflight section to the human channel. Quiet
// suppresses per-check lines but always prints failures.
func renderPreflight(u *ui.UI, res preflightResult, quiet bool) {
	if !quiet {
		u.Section("Preflight checks")
	}
	for _, c := range res.Checks {
		switch c.Status {
		case preflightOK:
			if !quiet {
				u.Ok("%s: %s", c.Name, c.Detail)
			}
		case preflightWarn, preflightFail:
			// Both show as a warning; a fail additionally aborts (see
			// preflightFailError).
			u.Warn("%s: %s", c.Name, c.Detail)
		}
	}
}

// preflightFailError builds the terminal error when a preflight check fails,
// naming each failing check so the teacher sees all blockers at once.
func preflightFailError(res preflightResult) error {
	var failed []string
	for _, c := range res.Checks {
		if c.Status == preflightFail {
			failed = append(failed, fmt.Sprintf("%s (%s)", c.Name, c.Detail))
		}
	}
	return fmt.Errorf("preflight failed — fix before re-running: %s", strings.Join(failed, "; "))
}

// initStepLabels are init's phase labels in order — used by --dry-run and the
// progress headers. One list so count and order can't drift.
var initStepLabels = []string{
	"Locking down org member privileges",
	"Enabling GitHub Actions (org)",
	"Setting the $0 Actions budget cap",
	"Allowing Actions to create pull requests (org)",
	"Installing branch rulesets (Feedback PR protections)",
	"Creating the config repo",
	"Enabling repo-level Actions",
	"Committing the skeleton workflows",
	"Enabling GitHub Pages",
	"Protecting the default branch",
	"Setting workflow permissions",
	"Granting reusable-workflow access",
	"Storing the service-token secret",
}

// renderDryRunSteps prints the ordered steps init would perform, for --dry-run.
func renderDryRunSteps(w io.Writer) {
	_, _ = fmt.Fprintln(w, "Dry run — init would perform these steps (no changes made):")
	for i, label := range initStepLabels {
		_, _ = fmt.Fprintf(w, "  %d. %s\n", i+1, label)
	}
}
