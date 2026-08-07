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
	"path/filepath"
	"strings"

	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/cli/go-gh/v2/pkg/auth"
	"github.com/cli/go-gh/v2/pkg/config"

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

// RequireClient returns an authenticated REST client. It reuses an
// already-sufficient token untouched so a working `gh` auth config is never
// disturbed just to re-request scopes it already has (issue #534). Only when
// the token is missing or under-scoped does it hand off to `gh`:
//   - no token: `gh auth login` (a fresh sign-in; warns that it rewrites gh's
//     stored auth).
//   - `gh`-managed token missing a scope: `gh auth refresh -s <scopes>`, which
//     ADDS the scopes to the existing credential without replacing its token or
//     other hosts.yml settings — the non-clobbering path.
//   - non-`gh` token (env var / PAT) missing a scope: not auto-fixed (`gh` can't
//     widen an env/PAT token); returns an error pointing at manual remediation.
//
// Non-interactive shells get a clear error instead of a hung browser flow.
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

	// Insufficient. Only a `gh`-managed token can be widened with
	// `gh auth refresh`; env/PAT tokens must be fixed by the user.
	if !isGhManagedToken(source) {
		return nil, fmt.Errorf(
			"your %s token (source: %s) is missing scopes %s needs (%s); it wasn't set by `gh auth login`, so re-run won't fix it — re-issue the token with those scopes, or unset it and run `%s login`",
			host, source, opts.CommandName, strings.Join(opts.RequiredScopes, ", "), opts.CommandName)
	}
	if !IsInteractiveTTY() {
		return nil, fmt.Errorf("your %s login is missing scopes %s needs (%s); run `gh auth refresh -h %s -s %s` (or `%s login`) from an interactive terminal to add them", host, opts.CommandName, strings.Join(opts.RequiredScopes, ", "), host, strings.Join(opts.RequiredScopes, ","), opts.CommandName)
	}
	// Widen the existing login in place — no fresh token, no config clobber.
	_, _ = fmt.Fprintf(errOut, "Your %s login is missing scopes %s needs (%s); running `gh auth refresh` to add them (your existing token is kept, not replaced)...\n", host, opts.CommandName, strings.Join(opts.RequiredScopes, ", "))
	if err := RunRefresh(out, errOut, host, opts.RequiredScopes, nil); err != nil {
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
// explicit `login` command. Warns first, prominently, that it hands control to
// `gh`, which mints a fresh token and rewrites the stored auth for this host in
// `gh`'s config (issue #534). Use this only for a FRESH sign-in (no token yet)
// or an explicit user `login`; to widen an existing login's scopes without
// replacing its token, prefer RunRefresh.
func RunLogin(out, errOut writer, host string, requiredScopes, extraScopes []string) error {
	printConfigRewriteWarning(errOut, host)
	return runGh(out, errOut, ghScopeArgs([]string{"auth", "login", "--hostname", host}, requiredScopes, extraScopes)...)
}

// RunRefresh execs `gh auth refresh --hostname <host> -s <scopes>` to ADD
// scopes to the host's existing stored credential, rather than minting a fresh
// token the way `gh auth login` does. This is the non-clobbering path: it
// preserves the user's token identity, git-protocol, and other hosts.yml
// settings, re-running only the OAuth consent to widen the grant (issue #534).
// It only works for a `gh`-managed OAuth credential (not a PAT / env token),
// which is why callers gate it behind isGhManagedToken.
func RunRefresh(out, errOut writer, host string, requiredScopes, extraScopes []string) error {
	return runGh(out, errOut, ghScopeArgs([]string{"auth", "refresh", "--hostname", host}, requiredScopes, extraScopes)...)
}

// ghScopeArgs appends `-s <scope>` for each required scope, then each non-empty
// trimmed extra scope, to base. Shared by the login and refresh invocations so
// both request scopes identically.
func ghScopeArgs(base, requiredScopes, extraScopes []string) []string {
	for _, s := range requiredScopes {
		base = append(base, "-s", s)
	}
	for _, s := range extraScopes {
		if s = strings.TrimSpace(s); s != "" {
			base = append(base, "-s", s)
		}
	}
	return base
}

// runGh execs `gh <args...>` with stdio wired through: stdin from the process
// (the OAuth flow reads it), stdout/stderr to the caller's writers.
func runGh(out, errOut writer, args ...string) error {
	sub := exec.Command("gh", args...)
	sub.Stdin = os.Stdin
	sub.Stdout = out
	sub.Stderr = errOut
	if err := sub.Run(); err != nil {
		return fmt.Errorf("gh %s: %w", strings.Join(args[:2], " "), err)
	}
	return nil
}

// Minimal SGR codes + rounded box-drawing runes for the config-rewrite warning.
// Hand-rolled (not the shared ghui renderer) because ghui imports ghauth for
// the TTY guard, so ghauth can't import ghui back without an import cycle.
const (
	warnAnsiReset  = "\x1b[0m"
	warnAnsiBold   = "\x1b[1m"
	warnAnsiYellow = "\x1b[33m"

	boxTopLeft     = "╭"
	boxTopRight    = "╮"
	boxBottomLeft  = "╰"
	boxBottomRight = "╯"
	boxHorizontal  = "─"
	boxVertical    = "│"
)

// printConfigRewriteWarning warns, prominently, that `gh auth login` is about
// to rewrite gh's stored auth for host (issue #534). On a color TTY it renders
// a yellow box; on a non-TTY / NO_COLOR it prints plain lines. Either way the
// literal "Warning:" prefix is present so log scrapers and tests keep matching.
func printConfigRewriteWarning(errOut writer, host string) {
	lines := []string{
		"Warning: this runs `gh auth login`, which rewrites gh's stored",
		fmt.Sprintf("authentication for %s in your gh config", host),
		fmt.Sprintf("(%s), replacing the token gh currently has.", hostsConfigPath()),
	}
	renderWarningBox(errOut, stderrWantsColor(errOut), lines)
}

// hostsConfigPath returns the platform-correct path to gh's hosts file — the
// file `gh auth login` rewrites — resolved the same way gh does (GH_CONFIG_DIR,
// then XDG_CONFIG_HOME, then Windows AppData, else ~/.config/gh). Never
// hardcode ~/.config/gh/hosts.yml: it's wrong on Windows and whenever
// GH_CONFIG_DIR / XDG_CONFIG_HOME is set.
func hostsConfigPath() string {
	return filepath.Join(config.ConfigDir(), "hosts.yml")
}

// renderWarningBox draws lines inside a yellow rounded box when color is true,
// or prints them as plain left-aligned lines otherwise. Box width fits the
// widest line; line widths ignore ANSI escapes so the border stays aligned.
// color is a parameter (not read inline) so tests can exercise both paths.
func renderWarningBox(errOut writer, color bool, lines []string) {
	if !color {
		for _, ln := range lines {
			_, _ = fmt.Fprintf(errOut, "%s\n", ln)
		}
		return
	}

	width := 0
	for _, ln := range lines {
		if w := displayWidth(ln); w > width {
			width = w
		}
	}
	const pad = 1 // one space of horizontal padding inside the border
	inner := width + pad*2

	yellow := func(s string) string { return warnAnsiYellow + s + warnAnsiReset }

	top := yellow(boxTopLeft + strings.Repeat(boxHorizontal, inner) + boxTopRight)
	bottom := yellow(boxBottomLeft + strings.Repeat(boxHorizontal, inner) + boxBottomRight)
	bar := yellow(boxVertical)

	_, _ = fmt.Fprintf(errOut, "%s\n", top)
	for _, ln := range lines {
		// Bold the leading "Warning:" so it stands out; right-pad to the box
		// interior using the ANSI-free display width.
		display := ln
		if rest, ok := strings.CutPrefix(ln, "Warning:"); ok {
			display = warnAnsiBold + "Warning:" + warnAnsiReset + rest
		}
		gap := width - displayWidth(ln)
		_, _ = fmt.Fprintf(errOut, "%s %s%s %s\n",
			bar, display, strings.Repeat(" ", gap), bar)
	}
	_, _ = fmt.Fprintf(errOut, "%s\n", bottom)
}

// stderrWantsColor reports whether to emit color/box drawing to w: w must be
// the real stderr and a TTY, with neither NO_COLOR nor CLASSROOM50_NO_COLOR
// set. Mirrors ghui.UseColor (duplicated to avoid an import cycle — ghui
// imports ghauth); keep the two in lockstep.
func stderrWantsColor(w writer) bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("CLASSROOM50_NO_COLOR") != "" {
		return false
	}
	return w == writer(os.Stderr) && IsCharDevice(os.Stderr)
}

// displayWidth counts the printed width of s as its rune count, skipping ANSI
// SGR escapes so a colored string still measures by its visible glyphs.
func displayWidth(s string) int {
	n, inEscape := 0, false
	for _, r := range s {
		switch {
		case inEscape:
			if r == 'm' {
				inEscape = false
			}
		case r == '\x1b':
			inEscape = true
		default:
			n++
		}
	}
	return n
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
