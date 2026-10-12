package configrepo

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestReadFileContents(t *testing.T) {
	const big = `{"schema":"v1","assignments":{}}`
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50/contents/cs50/small.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "sha": "small-sha",
			"encoding": "base64", "content": "e30=\n",
		})
	})
	// GitHub's shape for a file over the 1 MB inline ceiling (#1105): empty
	// content, encoding "none", but the blob sha is still present.
	mux.HandleFunc("/repos/o/classroom50/contents/cs50/scores.json", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ref") != "main" {
			t.Errorf("ref = %q, want main", r.URL.Query().Get("ref"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "sha": "big-sha", "size": 1148728,
			"encoding": "none", "content": "",
		})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs/big-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha": "big-sha", "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(big)),
		})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs50/no-sha.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "file", "encoding": "none", "content": ""})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs50/missing.json", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("inline base64 decodes", func(t *testing.T) {
		data, ok, err := ReadFileContents(client, "o", "classroom50", "cs50/small.json", "main")
		if err != nil || !ok {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
		if string(data) != "{}" {
			t.Errorf("data = %q, want {}", data)
		}
	})

	t.Run("oversized file falls back to the git-blobs API", func(t *testing.T) {
		data, ok, err := ReadFileContents(client, "o", "classroom50", "cs50/scores.json", "main")
		if err != nil || !ok {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
		if string(data) != big {
			t.Errorf("data = %q, want blob body", data)
		}
	})

	t.Run("non-base64 without a sha still errors", func(t *testing.T) {
		_, _, err := ReadFileContents(client, "o", "classroom50", "cs50/no-sha.json", "main")
		if err == nil || !strings.Contains(err.Error(), `unexpected encoding "none"`) {
			t.Fatalf("err = %v, want unexpected-encoding error", err)
		}
	})

	t.Run("404 returns ok=false without error", func(t *testing.T) {
		data, ok, err := ReadFileContents(client, "o", "classroom50", "cs50/missing.json", "main")
		if err != nil || ok || data != nil {
			t.Fatalf("data=%q ok=%v err=%v, want nil/false/nil", data, ok, err)
		}
	})
}

func TestListDirContents(t *testing.T) {
	mux := http.NewServeMux()
	// Root listing (empty path) → array of entries.
	mux.HandleFunc("/repos/o/classroom50/contents", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ref") != "main" {
			t.Errorf("ref = %q, want main", r.URL.Query().Get("ref"))
		}
		_ = json.NewEncoder(w).Encode([]map[string]string{
			{"name": "cs-principles", "path": "cs-principles", "type": "dir", "sha": "d1"},
			{"name": ".github", "path": ".github", "type": "dir", "sha": "d2"},
			{"name": "README.md", "path": "README.md", "type": "file", "sha": "f1"},
		})
	})
	// Missing directory → 404.
	mux.HandleFunc("/repos/o/classroom50/contents/missing", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("root listing decodes entries", func(t *testing.T) {
		entries, ok, err := ListDirContents(client, "o", "classroom50", "", "main")
		if err != nil || !ok {
			t.Fatalf("listDirContents: ok=%v err=%v", ok, err)
		}
		if len(entries) != 3 {
			t.Fatalf("len(entries) = %d, want 3", len(entries))
		}
		if entries[0].Name != "cs-principles" || entries[0].Type != "dir" {
			t.Errorf("entries[0] = %#v", entries[0])
		}
	})

	t.Run("404 returns ok=false without error", func(t *testing.T) {
		entries, ok, err := ListDirContents(client, "o", "classroom50", "missing", "main")
		if err != nil {
			t.Fatalf("listDirContents: %v", err)
		}
		if ok || entries != nil {
			t.Errorf("expected ok=false/nil, got ok=%v entries=%#v", ok, entries)
		}
	})
}

func TestListSubtreeBlobPaths(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "tree-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees/tree-sha", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("recursive") != "1" {
			t.Errorf("recursive = %q, want 1", r.URL.Query().Get("recursive"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tree": []map[string]string{
				{"path": "cs-principles", "type": "tree"},
				{"path": "cs-principles/classroom.json", "type": "blob"},
				{"path": "cs-principles/autograders", "type": "tree"},
				{"path": "cs-principles/autograders/hello/autograder.py", "type": "blob"},
				// Sibling whose name shares the prefix but isn't under it.
				{"path": "cs-principles-2/classroom.json", "type": "blob"},
				{"path": "other/scores.json", "type": "blob"},
			},
			"truncated": false,
		})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	paths, err := ListSubtreeBlobPaths(client, "o", "classroom50", "parent-sha", "cs-principles")
	if err != nil {
		t.Fatalf("listSubtreeBlobPaths: %v", err)
	}
	want := map[string]bool{
		"cs-principles/classroom.json":                  true,
		"cs-principles/autograders/hello/autograder.py": true,
	}
	if len(paths) != len(want) {
		t.Fatalf("paths = %v, want %d entries", paths, len(want))
	}
	for _, p := range paths {
		if !want[p] {
			t.Errorf("unexpected path %q (sibling/other dirs must not match the prefix)", p)
		}
	}
}

func TestListSubtreeBlobPaths_TruncatedErrors(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "tree-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees/tree-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tree":      []map[string]string{{"path": "cs-principles/a.txt", "type": "blob"}},
			"truncated": true,
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if _, err := ListSubtreeBlobPaths(client, "o", "classroom50", "parent-sha", "cs-principles"); err == nil {
		t.Fatal("expected error on truncated tree, got nil")
	}
}
