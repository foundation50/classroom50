package submitcmd

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundation50/gh-student/internal/githubtest"
)

func TestFetchRepoPath(t *testing.T) {
	// A repo with a top-level file and a one-level subdirectory served via the
	// contents API: a directory listing is a JSON array; a file is a JSON
	// object with base64 content. fetchRepoPath must recurse and write every
	// file under dstRoot preserving paths.
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

	mux := http.NewServeMux()
	// GET .github (directory) → one file + one subdir.
	mux.HandleFunc("/repos/o/r/contents/.github", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"type": "file", "path": ".github/CODEOWNERS"},
			{"type": "dir", "path": ".github/workflows"},
		})
	})
	mux.HandleFunc("/repos/o/r/contents/.github/CODEOWNERS", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "path": ".github/CODEOWNERS", "encoding": "base64", "content": b64("* @instructor\n"),
		})
	})
	mux.HandleFunc("/repos/o/r/contents/.github/workflows", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"type": "file", "path": ".github/workflows/ci.yml"},
		})
	})
	mux.HandleFunc("/repos/o/r/contents/.github/workflows/ci.yml", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "path": ".github/workflows/ci.yml", "encoding": "base64", "content": b64("name: CI\n"),
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	dst := t.TempDir()
	if err := fetchRepoPath(client, dst, "o", "r", "main", ".github"); err != nil {
		t.Fatalf("fetchRepoPath: %v", err)
	}

	for path, want := range map[string]string{
		".github/CODEOWNERS":       "* @instructor\n",
		".github/workflows/ci.yml": "name: CI\n",
	} {
		got, err := os.ReadFile(filepath.Join(dst, path))
		if err != nil {
			t.Errorf("expected %s written: %v", path, err)
			continue
		}
		if string(got) != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
}

func TestFetchRepoPath_RejectsNonBase64(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/contents/file.txt", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "path": "file.txt", "encoding": "utf-8", "content": "plain",
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	err := fetchRepoPath(client, t.TempDir(), "o", "r", "main", "file.txt")
	if err == nil || !strings.Contains(err.Error(), "unsupported encoding") {
		t.Fatalf("err = %v, want an 'unsupported encoding' error", err)
	}
}
