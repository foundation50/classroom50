package submitcmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-student/internal/githubtest"
)

func TestParseGitHubRemote(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantOwner string
		wantRepo  string
		wantErr   bool
	}{
		// `gh repo clone` defaults to SSH; students who switched gh to
		// https-only show the alternate form.
		{"SSH with .git", "git@github.com:cs50-fall-2026/cs-principles-hello-alice.git", "cs50-fall-2026", "cs-principles-hello-alice", false},
		{"SSH without .git", "git@github.com:cs50-fall-2026/cs-principles-hello-alice", "cs50-fall-2026", "cs-principles-hello-alice", false},
		{"HTTPS with .git", "https://github.com/cs50-fall-2026/cs-principles-hello-alice.git", "cs50-fall-2026", "cs-principles-hello-alice", false},
		{"HTTPS without .git", "https://github.com/cs50-fall-2026/cs-principles-hello-alice", "cs50-fall-2026", "cs-principles-hello-alice", false},
		{"SSH protocol", "ssh://git@github.com/cs50-fall-2026/cs-principles-hello-alice.git", "cs50-fall-2026", "cs-principles-hello-alice", false},
		{"with extra path", "https://github.com/cs50-fall-2026/cs-principles-hello-alice/something", "cs50-fall-2026", "cs-principles-hello-alice", false},
		{"surrounding whitespace", "  git@github.com:cs50-fall-2026/cs-principles-hello-alice.git\n", "cs50-fall-2026", "cs-principles-hello-alice", false},

		// Reject shapes — a clear error beats a malformed URL that 404s
		// downstream.
		{"non-GitHub remote", "git@gitlab.com:foo/bar.git", "", "", true},
		{"missing repo", "git@github.com:cs50-fall-2026/", "", "", true},
		{"missing owner", "https://github.com//cs-principles-hello-alice.git", "", "", true},
		{"only one segment", "git@github.com:cs50-fall-2026", "", "", true},
		{"empty", "", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			owner, repo, err := parseGitHubRemote(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got owner=%q repo=%q", tc.in, owner, repo)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseGitHubRemote(%q) returned %v", tc.in, err)
			}
			if owner != tc.wantOwner || repo != tc.wantRepo {
				t.Errorf("parseGitHubRemote(%q) = (%q, %q), want (%q, %q)",
					tc.in, owner, repo, tc.wantOwner, tc.wantRepo)
			}
		})
	}
}

func TestParseGitHubRemote_ErrorMentionsShape(t *testing.T) {
	// A non-GitHub remote should surface an error the student can understand.
	// The error text shapes the troubleshooting path (clone via gh, not bare
	// git remote).
	_, _, err := parseGitHubRemote("git@gitlab.com:foo/bar.git")
	if err == nil {
		t.Fatalf("expected error for gitlab.com remote")
	}
	if !strings.Contains(err.Error(), "git@github.com") {
		t.Errorf("error should hint at expected shape, got %q", err)
	}
}

func TestResolveRepoDefaultBranch(t *testing.T) {
	newClient := func(t *testing.T, handler http.HandlerFunc) *httptest.Server {
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		return server
	}

	t.Run("returns the repo's actual default branch (master)", func(t *testing.T) {
		server := newClient(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/repos/o/repo" {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "master"})
		})
		got, err := resolveRepoDefaultBranch(githubtest.NewTestClient(t, server), "o", "repo")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "master" {
			t.Errorf("got %q, want master", got)
		}
	})

	t.Run("empty default_branch falls back to main", func(t *testing.T) {
		server := newClient(t, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": ""})
		})
		got, err := resolveRepoDefaultBranch(githubtest.NewTestClient(t, server), "o", "repo")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "main" {
			t.Errorf("got %q, want main", got)
		}
	})

	t.Run("a failed GET is fatal (never silently pushes to main)", func(t *testing.T) {
		server := newClient(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		_, err := resolveRepoDefaultBranch(githubtest.NewTestClient(t, server), "o", "repo")
		if err == nil {
			t.Fatal("expected an error on a failed default-branch lookup")
		}
	})
}
