// Package ghauth holds the auth scaffolding shared by the gh-teacher and
// gh-student CLIs: resolving an authenticated go-gh REST client (auto-running
// `gh auth login` when no token is present), the interactive-TTY guard, and the
// `gh auth login` shell-out used by both the auto-login path and the explicit
// `login` command. The two CLIs differ only in required OAuth scopes and
// command name ("gh teacher" vs "gh student"), passed in via Options.
package ghauth

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/cli/go-gh/v2/pkg/auth"
)

// Options carries the per-CLI auth configuration.
type Options struct {
	// RequiredScopes are the extra OAuth scopes (beyond gh's defaults) the
	// CLI needs; requested on every `gh auth login` it triggers.
	RequiredScopes []string
	// CommandName is the user-facing command, e.g. "gh teacher" / "gh student",
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

// RequireClient returns an authenticated REST client, auto-running
// `gh auth login` (with opts.RequiredScopes) when no token is set for the
// default host, turning the cryptic "token not found" failure into a guided
// login. Non-interactive shells get a clear error instead.
func RequireClient(out, errOut writer, opts Options) (*api.RESTClient, error) {
	host := defaultHost()
	if token, _ := auth.TokenForHost(host); token == "" {
		if err := autoLogin(out, errOut, host, opts); err != nil {
			return nil, err
		}
	}
	client, err := api.DefaultRESTClient()
	if err != nil {
		return nil, fmt.Errorf("REST client: %w", err)
	}
	return client, nil
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
// explicit `login` command.
func RunLogin(out, errOut writer, host string, requiredScopes, extraScopes []string) error {
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
// because callers (e.g. the service-token prompt) check stdin/stderr
// independently, not just the combined interactive check.
func IsCharDevice(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
