package ghauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
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
