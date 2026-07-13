package ghutil

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
)

// TestNextPageLink pins the Link-header `rel="next"` parser both Go CLIs rely
// on. This regex is the single next-page extractor, so these edge cases guard
// against silent drift breaking pagination in both binaries while the rest of
// the suite stays green.
func TestNextPageLink(t *testing.T) {
	cases := []struct {
		name   string
		header string
		want   string
	}{
		{"empty header", "", ""},
		{"no next rel (prev/last only)",
			`<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=9>; rel="last"`,
			""},
		{"next first",
			`<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"`,
			"https://api.github.com/x?page=2"},
		{"next not first",
			`<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"`,
			"https://api.github.com/x?page=3"},
		{"rel=prevnext substring must not match",
			`<https://api.github.com/x?page=2>; rel="prevnext"`,
			""},
		{"single next",
			`<https://api.example.test/api/v3/x?page=2>; rel="next"`,
			"https://api.example.test/api/v3/x?page=2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NextPageLink(tc.header); got != tc.want {
				t.Errorf("NextPageLink(%q) = %q, want %q", tc.header, got, tc.want)
			}
		})
	}
}

// TestNextPage pins the shared termination decision both Go walks use, so the
// "follow next / stop / synthesize" predicate can't drift between paginateAll
// and the student collaborator walk.
func TestNextPage(t *testing.T) {
	const perPage = 100
	t.Run("follows rel=next regardless of page length", func(t *testing.T) {
		next, stop := NextPage(`<https://api.github.com/x?page=2>; rel="next"`, perPage, perPage)
		if stop || next != "https://api.github.com/x?page=2" {
			t.Errorf("got (%q, %v), want the next URL and stop=false", next, stop)
		}
	})
	t.Run("Link present without next stops even on a full page", func(t *testing.T) {
		next, stop := NextPage(`<https://api.github.com/x?page=1>; rel="prev"`, perPage, perPage)
		if !stop || next != "" {
			t.Errorf("got (%q, %v), want stop=true (last page) and no next URL", next, stop)
		}
	})
	t.Run("no Link + short page stops", func(t *testing.T) {
		next, stop := NextPage("", perPage-1, perPage)
		if !stop || next != "" {
			t.Errorf("got (%q, %v), want stop=true on a short no-Link page", next, stop)
		}
	})
	t.Run("no Link + full page synthesizes (continue)", func(t *testing.T) {
		next, stop := NextPage("", perPage, perPage)
		if stop || next != "" {
			t.Errorf("got (%q, %v), want (\"\", false) so the caller synthesizes page+1", next, stop)
		}
	})
}

func TestDecodeContentsBase64(t *testing.T) {
	// The contents API wraps base64 at column 60 with embedded newlines, which
	// the std decoder rejects, so the helper must strip them first.
	t.Run("strips embedded newlines", func(t *testing.T) {
		// "hello world" repeated, encoded then line-wrapped.
		wrapped := "aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29y\nbGQ="
		got, err := DecodeContentsBase64(wrapped)
		if err != nil {
			t.Fatalf("DecodeContentsBase64: %v", err)
		}
		want := "hello world hello world hello world hello world"
		if string(got) != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("decodes unwrapped", func(t *testing.T) {
		got, err := DecodeContentsBase64("aGk=")
		if err != nil {
			t.Fatalf("DecodeContentsBase64: %v", err)
		}
		if string(got) != "hi" {
			t.Errorf("got %q, want %q", got, "hi")
		}
	})

	t.Run("errors on invalid", func(t *testing.T) {
		if _, err := DecodeContentsBase64("!!!not-base64!!!"); err == nil {
			t.Error("expected error for invalid base64, got nil")
		}
	})
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

func TestCurrentUser(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"login": "alice", "id": 4242})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	login, id, err := CurrentUser(newTestRESTClient(t, server))
	if err != nil {
		t.Fatalf("CurrentUser: %v", err)
	}
	if login != "alice" || id != 4242 {
		t.Errorf("CurrentUser = (%q, %d), want (alice, 4242)", login, id)
	}
}

func TestSetCollaborator(t *testing.T) {
	// 201 = invitation created; 204 = added directly. The helper surfaces both
	// verbatim and rejects anything else.
	cases := []struct {
		name    string
		status  int
		wantErr bool
	}{
		{"created", http.StatusCreated, false},
		{"no content", http.StatusNoContent, false},
		{"forbidden is error", http.StatusForbidden, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/repos/o/r/collaborators/bob", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPut {
					t.Errorf("method = %s, want PUT", r.Method)
				}
				body, _ := io.ReadAll(r.Body)
				if want := `{"permission":"push"}`; string(body) != want {
					t.Errorf("body = %s, want %s", body, want)
				}
				w.WriteHeader(tc.status)
			})
			server := httptest.NewServer(mux)
			defer server.Close()

			status, err := SetCollaborator(newTestRESTClient(t, server), "o", "r", "bob", "push")
			if tc.wantErr {
				if err == nil {
					t.Errorf("expected error for status %d, got nil", tc.status)
				}
				return
			}
			if err != nil {
				t.Fatalf("SetCollaborator: %v", err)
			}
			if status != tc.status {
				t.Errorf("status = %d, want %d", status, tc.status)
			}
		})
	}
}

// TestWaitForStableBranch pins the post-create branch-stabilization poll the
// accept flow relies on: a branch reporting the same non-empty SHA on two
// consecutive reads resolves without error.
func TestWaitForStableBranch(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/branches/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"commit": map[string]any{"sha": "deadbeef"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	if err := WaitForStableBranch(newTestRESTClient(t, server), "o", "r", "main"); err != nil {
		t.Fatalf("WaitForStableBranch: %v", err)
	}
}

// TestResolveSettledDefaultBranch pins the async-copy-lag resolution the accept
// flow relies on: it must return the branch that actually materialized, not a
// transiently-reported default_branch, and fall back when nothing appears.
func TestResolveSettledDefaultBranch(t *testing.T) {
	t.Run("returns the settled default when it names a real branch", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/branches", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "master"}})
		})
		mux.HandleFunc("/repos/o/r", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "master"})
		})
		server := httptest.NewServer(mux)
		defer server.Close()

		got := ResolveSettledDefaultBranch(newTestRESTClient(t, server), "o", "r", "main", 5, time.Millisecond)
		if got != "master" {
			t.Errorf("got %q, want master", got)
		}
	})

	t.Run("returns the materialized branch when default_branch is stale", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/branches", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "master"}})
		})
		mux.HandleFunc("/repos/o/r", func(w http.ResponseWriter, _ *http.Request) {
			// Stale: names a branch (`main`) that doesn't exist yet.
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
		})
		server := httptest.NewServer(mux)
		defer server.Close()

		got := ResolveSettledDefaultBranch(newTestRESTClient(t, server), "o", "r", "main", 5, time.Millisecond)
		if got != "master" {
			t.Errorf("got %q, want master (the only materialized branch)", got)
		}
	})

	t.Run("falls back when no branch materializes", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/branches", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]string{})
		})
		server := httptest.NewServer(mux)
		defer server.Close()

		got := ResolveSettledDefaultBranch(newTestRESTClient(t, server), "o", "r", "fallback-br", 2, time.Millisecond)
		if got != "fallback-br" {
			t.Errorf("got %q, want fallback-br", got)
		}
	})
}
