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

	sha, err := CommitFiles(client, "o", "r", "main", "msg", map[string]string{"a.txt": "hi"})
	if err != nil {
		t.Fatalf("CommitFiles: unexpected error: %v", err)
	}
	if sha != "new-commit-sha" {
		// Not just non-empty: returning the tree or parent SHA here would
		// freeze the Feedback-PR base at a commit the runner's baseline check
		// rejects.
		t.Errorf("CommitFiles returned %q, want the new commit SHA new-commit-sha", sha)
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

	if _, err := CommitFiles(client, "o", "r", "main", "msg", nil); err != nil {
		t.Fatalf("CommitFiles(nil): %v", err)
	}
}

// TestDropFiles_NoAutograderOmitsShim pins the no_autograder / empty-shim
// behavior: an empty workflowContent must commit ONLY the .classroom50.yaml
// marker, never an empty .github/workflows/autograde.yaml. A non-empty shim
// still commits both. Also pins the init_shim README removal: the accept
// commit deletes the auto_init README when asked, and skips the deletion
// (rather than failing) when no README exists.
func TestDropFiles_NoAutograderOmitsShim(t *testing.T) {
	run := func(t *testing.T, workflowContent string, removeSeededReadme, readmeExists bool) (paths, deleted []string) {
		var mu sync.Mutex
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				w.WriteHeader(http.StatusOK)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"object": map[string]string{"sha": "parent-sha"},
			})
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
			var body struct {
				Tree []struct {
					Path string  `json:"path"`
					SHA  *string `json:"sha"`
				} `json:"tree"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			for _, e := range body.Tree {
				paths = append(paths, e.Path)
				// Upserts always carry the blob SHA, so a nil SHA is a deletion.
				if e.SHA == nil {
					deleted = append(deleted, e.Path)
				}
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "tree-sha"})
		})
		// The contents API probe WaitForStableBranch uses to confirm the branch.
		mux.HandleFunc("/repos/o/r/branches/main", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":   "main",
				"commit": map[string]string{"sha": "parent-sha"},
			})
		})
		// The init_shim README probe; an unregistered path 404s, so only the
		// README-present case needs a handler.
		if readmeExists {
			mux.HandleFunc("/repos/o/r/contents/README.md", func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"name": "README.md"})
			})
		}

		server := httptest.NewServer(mux)
		defer server.Close()
		client := githubtest.NewTestClient(t, server)

		cfg := Config{Classroom: "cs", Assignment: "hw"}
		if _, err := DropFiles(client, "o", "r", "main", cfg, workflowContent, removeSeededReadme); err != nil {
			t.Fatalf("DropFiles: %v", err)
		}
		mu.Lock()
		defer mu.Unlock()
		return paths, deleted
	}

	has := func(paths []string, want string) bool {
		for _, p := range paths {
			if p == want {
				return true
			}
		}
		return false
	}

	t.Run("empty shim commits only the marker", func(t *testing.T) {
		paths, deleted := run(t, "", false, true)
		if !has(paths, MetadataPath) {
			t.Errorf("marker %q not committed; paths=%v", MetadataPath, paths)
		}
		if has(paths, AutogradeWorkflowPath) {
			t.Errorf("no_autograder accept must not commit %q; paths=%v", AutogradeWorkflowPath, paths)
		}
		if len(deleted) != 0 {
			t.Errorf("non-init_shim accept must not delete anything; deleted=%v", deleted)
		}
	})

	t.Run("non-empty shim commits both", func(t *testing.T) {
		paths, _ := run(t, "name: Autograde\n", false, true)
		if !has(paths, MetadataPath) || !has(paths, AutogradeWorkflowPath) {
			t.Errorf("expected both marker and shim; paths=%v", paths)
		}
	})

	t.Run("init_shim removes the seeded README in the accept commit", func(t *testing.T) {
		paths, deleted := run(t, "name: Autograde\n", true, true)
		if !has(paths, MetadataPath) || !has(paths, AutogradeWorkflowPath) {
			t.Errorf("expected both marker and shim; paths=%v", paths)
		}
		if !has(deleted, SeededReadmePath) {
			t.Errorf("init_shim accept must delete %q; deleted=%v", SeededReadmePath, deleted)
		}
	})

	t.Run("init_shim skips the deletion when no README exists", func(t *testing.T) {
		_, deleted := run(t, "name: Autograde\n", true, false)
		if len(deleted) != 0 {
			t.Errorf("missing README must not produce a deletion entry; deleted=%v", deleted)
		}
	})
}
