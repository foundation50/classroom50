package submitcmd

import (
	"context"
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
			"type": "file", "path": ".github/CODEOWNERS", "encoding": "base64", "content": b64("* @teacher\n"),
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
	if err := fetchRepoPath(context.Background(), client, dst, "o", "r", "main", ".github"); err != nil {
		t.Fatalf("fetchRepoPath: %v", err)
	}

	for path, want := range map[string]string{
		".github/CODEOWNERS":       "* @teacher\n",
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

func TestFetchRepoPath_OversizedFileFallsBackToBlob(t *testing.T) {
	// GitHub's shape for a file over the 1 MB inline ceiling (#1105): empty
	// content, encoding "none", sha still present. The blob API serves it.
	const body = "big fixture\n"
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/contents/.github/fixture.bin", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "path": ".github/fixture.bin", "sha": "big-sha",
			"size": 1148728, "encoding": "none", "content": "",
		})
	})
	mux.HandleFunc("/repos/o/r/git/blobs/big-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha": "big-sha", "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(body)),
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	dst := t.TempDir()
	if err := fetchRepoPath(context.Background(), client, dst, "o", "r", "main", ".github/fixture.bin"); err != nil {
		t.Fatalf("fetchRepoPath: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dst, ".github/fixture.bin"))
	if err != nil {
		t.Fatalf("expected file written: %v", err)
	}
	if string(got) != body {
		t.Errorf("content = %q, want %q", got, body)
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

	err := fetchRepoPath(context.Background(), client, t.TempDir(), "o", "r", "main", "file.txt")
	if err == nil || !strings.Contains(err.Error(), "unsupported encoding") {
		t.Fatalf("err = %v, want an 'unsupported encoding' error", err)
	}
}
