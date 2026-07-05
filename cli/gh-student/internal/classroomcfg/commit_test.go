package classroomcfg

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/foundation50/gh-student/internal/githubtest"
)

// TestCommitFiles_RetriesOnFreshRepoLag pins the behavioral change when
// CommitFiles moved onto the shared fresh-repo-retry loop: a just-templated
// student repo whose first Tree write 409s "Git Repository is empty" must be
// retried, not surfaced as a failure. Before the refactor CommitFiles did a
// single attempt and would have errored.
func TestCommitFiles_RetriesOnFreshRepoLag(t *testing.T) {
	var (
		mu          sync.Mutex
		treeCalls   int
		patchCalled bool
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"object": map[string]string{"sha": "parent-sha"},
			})
		case http.MethodPatch:
			mu.Lock()
			patchCalled = true
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s on refs/heads/main", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/repos/o/r/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tree": map[string]string{"sha": "parent-tree"},
		})
	})
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		treeCalls++
		n := treeCalls
		mu.Unlock()
		if n == 1 {
			// First write hits the fresh-repo lag. go-gh only parses the
			// error body when the Content-Type declares JSON.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"message":"Git Repository is empty."}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "tree-sha"})
	})

	server := httptest.NewServer(mux)
	defer server.Close()
	client := githubtest.NewTestClient(t, server)

	err := CommitFiles(client, "o", "r", "main", "msg", map[string]string{"a.txt": "hi"})
	if err != nil {
		t.Fatalf("CommitFiles: unexpected error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if treeCalls != 2 {
		t.Errorf("tree write attempted %d times, want 2 (one 409, one success)", treeCalls)
	}
	if !patchCalled {
		t.Error("ref was never moved; commit did not land")
	}
}

// TestCommitFiles_EmptyIsNoop pins that an empty file set short-circuits
// before any API call.
func TestCommitFiles_EmptyIsNoop(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s for empty CommitFiles", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	client := githubtest.NewTestClient(t, server)

	if err := CommitFiles(client, "o", "r", "main", "msg", nil); err != nil {
		t.Fatalf("CommitFiles(nil): %v", err)
	}
}
