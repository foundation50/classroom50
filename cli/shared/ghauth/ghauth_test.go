package ghauth

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/go-gh/v2/pkg/api"
)

// TestScopesSatisfy pins the granted-vs-required decision that lets an
// already-sufficient token skip a re-login (issue #534): a superset satisfies,
// admin:org covers read:org (GitHub's implication), and a genuine gap does not.
func TestScopesSatisfy(t *testing.T) {
	cases := []struct {
		name     string
		granted  []string
		required []string
		want     bool
	}{
		{"exact match", []string{"repo", "workflow"}, []string{"repo", "workflow"}, true},
		{"granted superset", []string{"repo", "workflow", "gist"}, []string{"repo"}, true},
		{"admin:org implies read:org", []string{"admin:org", "repo", "workflow"}, []string{"admin:org", "read:org", "repo", "workflow"}, true},
		{"admin:org implies write:org", []string{"admin:org"}, []string{"write:org"}, true},
		{"write:org implies read:org but not admin:org", []string{"write:org"}, []string{"read:org"}, true},
		{"unified set satisfied by unified grant", []string{"admin:org", "repo", "workflow"}, []string{"admin:org", "read:org", "repo", "workflow"}, true},
		{"missing workflow", []string{"admin:org", "read:org", "repo"}, []string{"admin:org", "read:org", "repo", "workflow"}, false},
		{"read:org alone does not imply admin:org", []string{"read:org", "repo", "workflow"}, []string{"admin:org", "read:org", "repo", "workflow"}, false},
		{"empty granted, non-empty required", nil, []string{"repo"}, false},
		{"empty required is always satisfied", []string{"repo"}, nil, true},
		{"whitespace in granted list tolerated", []string{" repo ", "workflow"}, []string{"repo", "workflow"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := scopesSatisfy(tc.granted, tc.required); got != tc.want {
				t.Errorf("scopesSatisfy(%v, %v) = %v, want %v", tc.granted, tc.required, got, tc.want)
			}
		})
	}
}

// TestConfirmProceed pins the re-login confirmation: only an explicit yes
// proceeds; empty (bare Enter), no, and EOF all default to No so the safe
// choice — leaving the existing auth untouched — is the effortless one.
func TestConfirmProceed(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"y proceeds", "y\n", true},
		{"yes proceeds", "yes\n", true},
		{"uppercase Y proceeds", "Y\n", true},
		{"padded yes proceeds", "  yes  \n", true},
		{"bare enter declines", "\n", false},
		{"n declines", "n\n", false},
		{"no declines", "no\n", false},
		{"garbage declines", "maybe\n", false},
		{"EOF declines", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var errOut bytes.Buffer
			got := confirmProceed(&errOut, strings.NewReader(tc.in))
			if got != tc.want {
				t.Errorf("confirmProceed(%q) = %v, want %v", tc.in, got, tc.want)
			}
			if !strings.Contains(errOut.String(), "Proceed") {
				t.Errorf("confirmProceed must print a prompt; got %q", errOut.String())
			}
		})
	}
}

// TestPrintLoginDeclinedHelp pins the post-decline guidance: it must name the
// two no-clobber alternatives the reporter asked for (issue #534) — refreshing
// the existing login and supplying your own token via GH_TOKEN — with the
// required scopes filled in.
func TestPrintLoginDeclinedHelp(t *testing.T) {
	var buf bytes.Buffer
	printLoginDeclinedHelp(&buf, "github.com", []string{"admin:org", "workflow"})
	got := buf.String()
	for _, want := range []string{
		"gh auth refresh -h github.com -s admin:org,workflow",
		"GH_TOKEN",
		"unchanged",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("decline help missing %q:\n%s", want, got)
		}
	}
}

// TestGhScopeArgs pins the `gh auth login`/`refresh` argument builder shared by
// the login and refresh paths: each required scope and each non-empty trimmed
// extra scope becomes a `-s <scope>` pair appended to the base command.
func TestGhScopeArgs(t *testing.T) {
	got := ghScopeArgs(
		[]string{"auth", "refresh", "--hostname", "github.com"},
		[]string{"admin:org", "workflow"},
		[]string{" gist ", "", "read:user"},
	)
	want := []string{
		"auth", "refresh", "--hostname", "github.com",
		"-s", "admin:org", "-s", "workflow",
		"-s", "gist", "-s", "read:user",
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("ghScopeArgs = %v, want %v", got, want)
	}
}

// TestHostsConfigPath verifies the warning points at gh's real hosts file
// resolved per-platform (via go-gh's config.ConfigDir), not a hardcoded
// ~/.config/gh path: setting GH_CONFIG_DIR must move it, proving it isn't
// macOS/Linux-only and honors gh's own precedence.
func TestHostsConfigPath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GH_CONFIG_DIR", dir)

	got := hostsConfigPath()
	want := filepath.Join(dir, "hosts.yml")
	if got != want {
		t.Errorf("hostsConfigPath() = %q, want %q (should honor GH_CONFIG_DIR)", got, want)
	}
}

// TestRenderWarningBox pins the config-rewrite warning renderer (issue #534):
// the plain path stays ANSI-free and keeps the literal "Warning:" prefix so
// log scrapers/tests match; the color path draws an aligned yellow box whose
// borders line up regardless of the widest line.
func TestRenderWarningBox(t *testing.T) {
	lines := []string{
		"Warning: this runs `gh auth login`, which rewrites gh's stored",
		"authentication for github.com in your gh config",
		"(e.g. ~/.config/gh/hosts.yml), replacing the token gh currently has.",
	}

	t.Run("plain path is ANSI-free and keeps Warning prefix", func(t *testing.T) {
		var buf bytes.Buffer
		renderWarningBox(&buf, false, lines)
		got := buf.String()
		if strings.Contains(got, "\x1b[") {
			t.Errorf("plain path must not emit ANSI escapes:\n%q", got)
		}
		if strings.ContainsAny(got, boxTopLeft+boxVertical+boxBottomRight) {
			t.Errorf("plain path must not draw box-drawing runes:\n%q", got)
		}
		if !strings.Contains(got, "Warning:") {
			t.Errorf("plain path must keep the literal Warning: prefix:\n%q", got)
		}
		for _, ln := range lines {
			if !strings.Contains(got, ln) {
				t.Errorf("plain path dropped a line %q:\n%q", ln, got)
			}
		}
	})

	t.Run("color path draws an aligned yellow box", func(t *testing.T) {
		var buf bytes.Buffer
		renderWarningBox(&buf, true, lines)
		out := buf.String()
		if !strings.Contains(out, warnAnsiYellow) {
			t.Errorf("color path must emit the yellow SGR code:\n%q", out)
		}
		if !strings.Contains(out, boxTopLeft) || !strings.Contains(out, boxBottomRight) {
			t.Errorf("color path must draw the box corners:\n%q", out)
		}
		// Every rendered row must have the same visible width, so the right
		// border lines up under the top border.
		rows := strings.Split(strings.TrimRight(out, "\n"), "\n")
		for i, row := range rows {
			if w := displayWidth(row); w != displayWidth(rows[0]) {
				t.Errorf("row %d visible width %d != top border width %d; box misaligned:\n%q",
					i, w, displayWidth(rows[0]), out)
			}
		}
	})
}

// TestDisplayWidth pins the ANSI-aware width used to align the box border: it
// counts visible runes and skips SGR escapes.
func TestDisplayWidth(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"\x1b[33mabc\x1b[0m", 3},
		{"\x1b[1mWarning:\x1b[0m x", 10},
	}
	for _, tc := range cases {
		if got := displayWidth(tc.in); got != tc.want {
			t.Errorf("displayWidth(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestIsGhManagedToken pins which TokenForHost sources count as gh-managed —
// the cases where re-running `gh auth login` can add scopes safely. go-gh
// returns "gh" for a keyring/secure-storage token and "oauth_token" for the
// config-file token; env sources (GH_TOKEN / GITHUB_TOKEN) are user-managed.
// A miss here (issue #534 review) misclassifies the default keyring token and
// wrongly hard-errors instead of auto-fixing it.
func TestIsGhManagedToken(t *testing.T) {
	cases := []struct {
		source string
		want   bool
	}{
		{"gh", true},          // keyring / secure storage (go-gh default)
		{"oauth_token", true}, // hosts.yml config file
		{"GH_TOKEN", false},   // env var — user-managed
		{"GITHUB_TOKEN", false},
		{"default", false}, // no token found
		{"", false},
		{" GH ", true}, // case/space tolerant
	}
	for _, tc := range cases {
		t.Run(tc.source, func(t *testing.T) {
			if got := isGhManagedToken(tc.source); got != tc.want {
				t.Errorf("isGhManagedToken(%q) = %v, want %v", tc.source, got, tc.want)
			}
		})
	}
}

type hostRewriteTransport struct{ target *url.URL }

func (h *hostRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = h.target.Scheme
	req.URL.Host = h.target.Host
	return http.DefaultTransport.RoundTrip(req)
}

func newTestRESTClient(t *testing.T, server *httptest.Server) *api.RESTClient {
	t.Helper()
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	client, err := api.NewRESTClient(api.ClientOptions{
		Host:         "github.com",
		AuthToken:    "test-token",
		Transport:    &hostRewriteTransport{target: u},
		LogIgnoreEnv: true,
	})
	if err != nil {
		t.Fatalf("api.NewRESTClient: %v", err)
	}
	return client
}

// TestTokenHasScopes pins the live-probe half: it reads the X-OAuth-Scopes
// header off a cheap authenticated request and reports whether the granted set
// satisfies the required set. This is what lets RequireClient skip login for an
// already-sufficient token (#534).
func TestTokenHasScopes(t *testing.T) {
	t.Run("sufficient token reports true", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-OAuth-Scopes", "admin:org, read:org, repo, workflow")
			w.WriteHeader(http.StatusOK)
		})
		server := httptest.NewServer(mux)
		defer server.Close()

		ok, err := tokenHasScopes(newTestRESTClient(t, server), []string{"admin:org", "read:org", "repo", "workflow"})
		if err != nil {
			t.Fatalf("tokenHasScopes: %v", err)
		}
		if !ok {
			t.Error("want true for a token whose granted scopes cover the required set")
		}
	})

	t.Run("insufficient token reports false", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-OAuth-Scopes", "repo")
			w.WriteHeader(http.StatusOK)
		})
		server := httptest.NewServer(mux)
		defer server.Close()

		ok, err := tokenHasScopes(newTestRESTClient(t, server), []string{"admin:org", "read:org", "repo", "workflow"})
		if err != nil {
			t.Fatalf("tokenHasScopes: %v", err)
		}
		if ok {
			t.Error("want false when workflow/admin:org/read:org are not granted")
		}
	})

	t.Run("transport error surfaces", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
		server.Close() // force a connection failure

		if _, err := tokenHasScopes(newTestRESTClient(t, server), []string{"repo"}); err == nil {
			t.Error("want a transport error when the request cannot complete")
		}
	})
}
