// Package ghauth holds the auth scaffolding shared by the gh-teacher and
// gh-student CLIs: resolving an authenticated go-gh REST client (auto-running
// `gh auth login` when no token is present, OR when a gh-managed token lacks a
// required scope — reusing an already-sufficient token so a working `gh` auth
// config is never rewritten just to re-request scopes it already has, issue
// #534), the interactive-TTY guard, and the `gh auth login` shell-out used by
// both the auto-login path and the explicit `login` command. The two CLIs
// differ only in required OAuth scopes and command name ("gh teacher" vs
// "gh student"), passed in via Options.
package ghauth

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/cli/go-gh/v2/pkg/auth"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// Options carries the per-CLI auth configuration.
type Options struct {
	// RequiredScopes are the extra OAuth scopes (beyond gh's defaults) the
	// CLI needs; requested on every `gh auth login` it triggers.
	RequiredScopes []string
	// CommandName is the user-facing command, e.g., "gh teacher" / "gh student",
	// used in guidance messages so they point at the right login command.
	CommandName string
}

// writer is the minimal output sink (cobra's OutOrStdout/ErrOrStderr satisfy it).
type writer interface{ Write([]byte) (int, error) }

// defaultHost returns the configured GitHub host, defaulting to github.com.
func defaultHost() string {
	host, _ := auth.DefaultHost()
	if host == "" {
		host = "github.com"
	}
	return host
}

// RequireClient returns an authenticated REST client. It auto-runs
// `gh auth login` (with opts.RequiredScopes) only when the host has no token,
// OR when the existing token is a `gh`-managed OAuth token that lacks a
// required scope — reusing an already-sufficient token so we never rewrite a
// user's working `gh` auth config just to re-request scopes it already has
// (issue #534). A token from a non-`gh` source (env var / keyring) that is
// insufficient is not silently re-authed: `gh auth login` can't rewrite an
// env token and clobbering a keyring token is surprising, so we point the user
// at manual remediation instead. Non-interactive shells get a clear error.
func RequireClient(out, errOut writer, opts Options) (*api.RESTClient, error) {
	host := defaultHost()
	token, source := auth.TokenForHost(host)

	if token == "" {
		if err := autoLogin(out, errOut, host, opts); err != nil {
			return nil, err
		}
		return newDefaultClient()
	}

	client, err := newDefaultClient()
	if err != nil {
		return nil, err
	}

	// A present token might still lack a scope we need. Probe it; on an
	// inconclusive probe (network/transport error) proceed with the token
	// rather than forcing a disruptive re-login on a transient failure.
	ok, probeErr := tokenHasScopes(client, opts.RequiredScopes)
	if probeErr != nil || ok {
		return client, nil
	}

	// Insufficient. Only a `gh`-managed token is safe to fix with
	// `gh auth login`; env/keyring tokens must be fixed by the user.
	if !isGhManagedToken(source) {
		return nil, fmt.Errorf(
			"your %s token (source: %s) is missing scopes %s needs (%s); it wasn't set by `gh auth login`, so re-run won't fix it — re-issue the token with those scopes, or unset it and run `%s login`",
			host, source, opts.CommandName, strings.Join(opts.RequiredScopes, ", "), opts.CommandName)
	}
	_, _ = fmt.Fprintf(errOut, "Your %s login is missing scopes %s needs (%s); running `%s login` to add them...\n", host, opts.CommandName, strings.Join(opts.RequiredScopes, ", "), opts.CommandName)
	if err := autoLogin(out, errOut, host, opts); err != nil {
		return nil, err
	}
	return newDefaultClient()
}

// newDefaultClient builds go-gh's default REST client (reads the ambient gh
// auth/host config), wrapping the error for callers.
func newDefaultClient() (*api.RESTClient, error) {
	client, err := api.DefaultRESTClient()
	if err != nil {
		return nil, fmt.Errorf("REST client: %w", err)
	}
	return client, nil
}

// isGhManagedToken reports whether TokenForHost's source string denotes a token
// `gh auth login` owns — the hosts.yml `oauth_token` (config-file storage) or
// `gh` (the default OS-keyring / secure-storage path, which go-gh reports by
// shelling out to `gh auth token`). These are the only cases where re-running
// `gh auth login` can add scopes without clobbering something the user set by
// hand. An env-var source (GH_TOKEN / GITHUB_TOKEN) is user-managed → false.
func isGhManagedToken(source string) bool {
	s := strings.ToLower(strings.TrimSpace(source))
	return s == "oauth_token" || s == "gh"
}

// scopesSatisfy reports whether the granted scopes cover every required scope.
// Delegates to the shared contract scope-hierarchy source (honoring GitHub's
// admin:org ⊇ read:org/write:org implications) so this auto-login probe and
// gh-teacher's init preflight can never disagree on what a token satisfies.
func scopesSatisfy(granted, required []string) bool {
	return contract.ScopesSatisfy(granted, required)
}

// tokenHasScopes probes the client's token via a cheap authenticated request
// (GET /, the API root) and reports whether its granted OAuth scopes — read
// from the X-OAuth-Scopes response header — satisfy required. A transport
// error is returned so callers can treat the probe as inconclusive. An empty
// required set is vacuously satisfied and skips the request.
func tokenHasScopes(client *api.RESTClient, required []string) (bool, error) {
	if len(required) == 0 {
		return true, nil
	}
	resp, err := client.Request(http.MethodGet, "", nil)
	if err != nil {
		return false, fmt.Errorf("probe token scopes: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	granted := contract.ParseScopeList(resp.Header.Get("X-OAuth-Scopes"))
	return scopesSatisfy(granted, required), nil
}

// autoLogin shells out to `gh auth login` with the CLI's scopes against the
// host RequireClient checked. Mirrors the explicit `login` command so a fresh
// user lands in the same flow.
func autoLogin(out, errOut writer, host string, opts Options) error {
	if !IsInteractiveTTY() {
		return fmt.Errorf("not signed in to %s; run `%s login` from an interactive terminal to authenticate", host, opts.CommandName)
	}
	_, _ = fmt.Fprintf(errOut, "Not signed in to %s; running `%s login` to authenticate...\n", host, opts.CommandName)
	return RunLogin(out, errOut, host, opts.RequiredScopes, nil)
}

// RunLogin execs `gh auth login --hostname <host>` with the required scopes
// plus any extra scopes, wiring stdio through. Shared by autoLogin and the
// explicit `login` command. Warns first that it hands control to `gh`, which
// rewrites the stored auth for this host in `gh`'s config (issue #534).
func RunLogin(out, errOut writer, host string, requiredScopes, extraScopes []string) error {
	_, _ = fmt.Fprintf(errOut, "Note: this runs `gh auth login`, which will update %s's stored authentication in your gh config (e.g. ~/.config/gh/hosts.yml) — replacing the token gh has for %s.\n", host, host)
	args := []string{"auth", "login", "--hostname", host}
	for _, s := range requiredScopes {
		args = append(args, "-s", s)
	}
	for _, s := range extraScopes {
		if s = strings.TrimSpace(s); s != "" {
			args = append(args, "-s", s)
		}
	}
	sub := exec.Command("gh", args...)
	sub.Stdin = os.Stdin
	sub.Stdout = out
	sub.Stderr = errOut
	if err := sub.Run(); err != nil {
		return fmt.Errorf("gh auth login: %w", err)
	}
	return nil
}

// DefaultHost is exported for the `login` command, which needs the host to
// build its own `gh auth login` invocation.
func DefaultHost() string { return defaultHost() }

// IsInteractiveTTY: both stdin and stderr must be a TTY because
// `gh auth login` reads from stdin and prompts on stderr.
func IsInteractiveTTY() bool {
	return IsCharDevice(os.Stdin) && IsCharDevice(os.Stderr)
}

// IsCharDevice reports whether f is a character device (a TTY). Exported
// because callers (e.g., the service-token prompt) check stdin/stderr
// independently, not just the combined interactive check.
func IsCharDevice(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
