package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// TestCommitSkeleton_RetriesTransientTreeWrite reproduces the
// `gh teacher init` 404/409 failure on a freshly auto_init'd repo: the
// branch ref and commit are readable, but the Tree write transiently
// 409s "Git Repository is empty" until the git database settles. The
// old code retried only the ref read and called createTree once, so it
// died here. buildSkeletonCommit must retry the read+build and land
// the commit on attempt 2.
func TestCommitSkeleton_RetriesTransientTreeWrite(t *testing.T) {
	var (
		mu        sync.Mutex
		treePosts int
		patched   bool
	)

	mux := http.NewServeMux()

	// Probe: skeleton not present yet -> commit proceeds.
	mux.HandleFunc("/repos/o/r/contents/.github/workflows/publish-pages.yaml", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})

	// waitForStableBranch: report a stable, non-empty tip so it
	// returns after two agreeing reads.
	mux.HandleFunc("/repos/o/r/branches/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]string{"sha": "c0"}})
	})

	mux.HandleFunc("/repos/o/r/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "c0"}})
		case http.MethodPatch:
			mu.Lock()
			patched = true
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s on refs/heads/main", r.Method)
		}
	})
	mux.HandleFunc("/repos/o/r/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		// GET commits/{sha} -> parent tree SHA.
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "t0"}})
	})
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "c1"})
	})
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n := treePosts + 1
		treePosts = n
		mu.Unlock()
		if n == 1 {
			// First write: the fresh-repo transient. Content-Type
			// application/json is required for go-gh to populate the
			// HTTPError message; the status drives isSkeletonRetryable.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"message":"Git Repository is empty."}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "t1"})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, io.Discard, "o", "r", "main", false); err != nil {
		t.Fatalf("commitSkeleton returned error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if treePosts != 2 {
		t.Errorf("createTree called %d times, want 2 (one transient 409, one success)", treePosts)
	}
	if !patched {
		t.Error("ref was never PATCHed; the commit never landed")
	}
}

// serveSkeletonContents registers a contents handler that serves every
// embedded skeleton file (post-substitution for `branch`). overrides,
// if non-nil, can substitute content per (path, ref) — `ref` is the
// query ?ref= value, which distinguishes the initial branch-tip diff
// from the per-attempt parent-SHA re-diff inside the rebase loop.
// Returns the embedded files map for assertions.
func serveSkeletonContents(t *testing.T, mux *http.ServeMux, branch string,
	overrides func(path, ref string) (string, bool)) map[string]string {
	t.Helper()
	files, err := skeletonFiles(branch)
	if err != nil {
		t.Fatalf("skeletonFiles: %v", err)
	}
	mux.HandleFunc("/repos/o/r/contents/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/repos/o/r/contents/")
		content, ok := "", false
		if overrides != nil {
			content, ok = overrides(path, r.URL.Query().Get("ref"))
		}
		if !ok {
			if content, ok = files[path]; !ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"message":"Not Found"}`)
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"content":  base64.StdEncoding.EncodeToString([]byte(content)),
			"encoding": "base64",
		})
	})
	return files
}

// stalePaths builds an override that reports the given paths stale at
// every ref.
func stalePaths(paths ...string) func(path, ref string) (string, bool) {
	return func(path, _ string) (string, bool) {
		for _, p := range paths {
			if p == path {
				return "# stale\n", true
			}
		}
		return "", false
	}
}

// TestCommitSkeleton_UpToDateSkeletonNoOps: a re-run where every
// skeleton file already matches the embedded version must report "up to
// date" and land no commit.
func TestCommitSkeleton_UpToDateSkeletonNoOps(t *testing.T) {
	var (
		mu        sync.Mutex
		gitDataOK = true
	)

	mux := http.NewServeMux()
	serveSkeletonContents(t, mux, "main", nil)
	// Any git-data write means the up-to-date path failed.
	flagWrite := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gitDataOK = false
		mu.Unlock()
		t.Errorf("unexpected git-data call %s %s for an up-to-date skeleton", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}
	for _, p := range []string{"/repos/o/r/git/blobs", "/repos/o/r/git/trees", "/repos/o/r/git/commits", "/repos/o/r/branches/main"} {
		mux.HandleFunc(p, flagWrite)
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, io.Discard, "o", "r", "main", false); err != nil {
		t.Fatalf("commitSkeleton returned error: %v", err)
	}
	if !strings.Contains(out.String(), "workflow and script files up to date") {
		t.Errorf("out = %q, want up-to-date note", out.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if !gitDataOK {
		t.Error("commitSkeleton hit git-data endpoints despite an up-to-date skeleton")
	}
}

// registerRefreshCommitEndpoints wires the configwrite.CommitTree endpoints and
// captures the tree paths of the refresh commit.
func registerRefreshCommitEndpoints(t *testing.T, mux *http.ServeMux) (treePaths *[]string, patched *bool, mu *sync.Mutex) {
	t.Helper()
	var (
		lock    sync.Mutex
		paths   []string
		flipped bool
	)
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			lock.Lock()
			flipped = true
			lock.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/r/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/r/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Tree []struct {
				Path string `json:"path"`
			} `json:"tree"`
		}
		_ = json.Unmarshal(body, &payload)
		lock.Lock()
		paths = paths[:0]
		for _, e := range payload.Tree {
			paths = append(paths, e.Path)
		}
		lock.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree"})
	})
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit"})
	})
	return &paths, &flipped, &lock
}

// TestCommitSkeleton_RefreshesStaleFiles: a re-run against a repo whose
// runner.py predates the embedded version must commit exactly the stale
// path (--yes skips the prompt).
func TestCommitSkeleton_RefreshesStaleFiles(t *testing.T) {
	mux := http.NewServeMux()
	serveSkeletonContents(t, mux, "main", stalePaths(".github/scripts/runner.py"))
	treePaths, patched, mu := registerRefreshCommitEndpoints(t, mux)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, &errOut, "o", "r", "main", true); err != nil {
		t.Fatalf("commitSkeleton: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(*treePaths) != 1 || (*treePaths)[0] != ".github/scripts/runner.py" {
		t.Errorf("refresh committed %v, want only .github/scripts/runner.py", *treePaths)
	}
	if !*patched {
		t.Error("ref was never PATCHed; the refresh never landed")
	}
	if !strings.Contains(out.String(), "workflow and script files refreshed (1 file(s))") {
		t.Errorf("out = %q, want refreshed note", out.String())
	}
	if !strings.Contains(errOut.String(), ".github/scripts/runner.py") {
		t.Errorf("errOut = %q, want the stale path listed", errOut.String())
	}
}

// TestCommitSkeleton_RefreshReportsLandedCount: when a concurrent
// writer fixes one of two stale files between the initial diff and the
// commit attempt, the re-diff inside the rebase loop commits only the
// remaining file — and the message reports 1, not the pre-confirmation 2.
func TestCommitSkeleton_RefreshReportsLandedCount(t *testing.T) {
	mux := http.NewServeMux()
	serveSkeletonContents(t, mux, "main", func(path, ref string) (string, bool) {
		if path == ".github/scripts/runner.py" {
			return "# stale\n", true // stale at every ref
		}
		// Stale only at the initial branch-tip diff (ref=main); the
		// per-attempt re-diff (ref=parent-sha) sees it already fixed.
		if path == ".github/scripts/collect_scores.py" && ref == "main" {
			return "# stale\n", true
		}
		return "", false
	})
	treePaths, patched, mu := registerRefreshCommitEndpoints(t, mux)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, &errOut, "o", "r", "main", true); err != nil {
		t.Fatalf("commitSkeleton: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(*treePaths) != 1 || (*treePaths)[0] != ".github/scripts/runner.py" {
		t.Errorf("refresh committed %v, want only the still-stale runner.py", *treePaths)
	}
	if !*patched {
		t.Error("ref was never PATCHed")
	}
	if !strings.Contains(out.String(), "workflow and script files refreshed (1 file(s))") {
		t.Errorf("out = %q, want the landed count (1), not the initial diff (2)", out.String())
	}
}

// TestCommitSkeleton_RefreshAllFixedConcurrently: everything stale at
// the initial diff was fixed by a concurrent writer before the commit
// attempt — no commit lands and the message says so.
func TestCommitSkeleton_RefreshAllFixedConcurrently(t *testing.T) {
	mux := http.NewServeMux()
	serveSkeletonContents(t, mux, "main", func(path, ref string) (string, bool) {
		if path == ".github/scripts/runner.py" && ref == "main" {
			return "# stale\n", true
		}
		return "", false
	})
	_, patched, mu := registerRefreshCommitEndpoints(t, mux)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, &errOut, "o", "r", "main", true); err != nil {
		t.Fatalf("commitSkeleton: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if *patched {
		t.Error("no commit should land when the re-diff finds nothing stale")
	}
	if !strings.Contains(out.String(), "nothing to commit") {
		t.Errorf("out = %q, want concurrent-writer note", out.String())
	}
}

// TestCommitSkeleton_RefreshPromptAccepted: an interactive "y" commits.
func TestCommitSkeleton_RefreshPromptAccepted(t *testing.T) {
	mux := http.NewServeMux()
	serveSkeletonContents(t, mux, "main", stalePaths(".github/scripts/runner.py"))
	_, patched, mu := registerRefreshCommitEndpoints(t, mux)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader("y\n"), &out, &errOut, "o", "r", "main", false); err != nil {
		t.Fatalf("commitSkeleton: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !*patched {
		t.Error("confirmed refresh never landed")
	}
	if !strings.Contains(errOut.String(), "Overwrite them") {
		t.Errorf("errOut = %q, want the confirmation prompt", errOut.String())
	}
}

// TestCommitSkeleton_RefreshDeclined: anything but y/yes leaves the
// repo untouched and is not an error (init continues).
func TestCommitSkeleton_RefreshDeclined(t *testing.T) {
	var (
		mu        sync.Mutex
		gitDataOK = true
	)
	mux := http.NewServeMux()
	serveSkeletonContents(t, mux, "main", stalePaths(".github/scripts/runner.py"))
	flagWrite := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gitDataOK = false
		mu.Unlock()
		t.Errorf("unexpected git-data call %s %s after a declined refresh", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}
	for _, p := range []string{"/repos/o/r/git/blobs", "/repos/o/r/git/trees", "/repos/o/r/git/commits", "/repos/o/r/git/refs/heads/main"} {
		mux.HandleFunc(p, flagWrite)
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader("n\n"), &out, io.Discard, "o", "r", "main", false); err != nil {
		t.Fatalf("a declined refresh must not error: %v", err)
	}
	if !strings.Contains(out.String(), "refresh declined") {
		t.Errorf("out = %q, want declined note", out.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if !gitDataOK {
		t.Error("declined refresh still hit git-data endpoints")
	}
}

// TestCommitSkeleton_MissingWorkflowScopeFailsFast: without `workflow`
// scope the Tree write 404s permanently, so it must fail after one Tree
// POST, not retry it as fresh-repo lag. Guards https://github.com/foundation50/classroom50/issues/16.
func TestCommitSkeleton_MissingWorkflowScopeFailsFast(t *testing.T) {
	var (
		mu        sync.Mutex
		treePosts int
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/contents/.github/workflows/publish-pages.yaml", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/repos/o/r/branches/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]string{"sha": "c0"}})
	})
	mux.HandleFunc("/repos/o/r/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "c0"}})
	})
	mux.HandleFunc("/repos/o/r/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "t0"}})
	})
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		treePosts++
		mu.Unlock()
		// GitHub's obfuscated rejection: 404 + a scope list without
		// `workflow`. Content-Type lets go-gh build the HTTPError.
		w.Header().Set("X-OAuth-Scopes", "admin:org, gist, repo")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"Not Found"}`)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	err := commitSkeleton(client, strings.NewReader(""), &out, io.Discard, "o", "r", "main", false)
	if err == nil {
		t.Fatal("commitSkeleton should fail when the token lacks the workflow scope")
	}
	if !errors.Is(err, configwrite.ErrMissingWorkflowScope) {
		t.Errorf("error should wrap configwrite.ErrMissingWorkflowScope, got: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if treePosts != 1 {
		t.Errorf("createTree called %d times, want 1 (a scope error is permanent, not retried)", treePosts)
	}
}

// TestCommitSkeleton_NotFoundWithWorkflowScopeStillRetries: with
// `workflow` scope present, a 404 is fresh-repo lag, not a scope error,
// so it must still retry and land -- no regression to the retry path.
func TestCommitSkeleton_NotFoundWithWorkflowScopeStillRetries(t *testing.T) {
	var (
		mu        sync.Mutex
		treePosts int
		patched   bool
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/contents/.github/workflows/publish-pages.yaml", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/repos/o/r/branches/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]string{"sha": "c0"}})
	})
	mux.HandleFunc("/repos/o/r/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "c0"}})
		case http.MethodPatch:
			mu.Lock()
			patched = true
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s on refs/heads/main", r.Method)
		}
	})
	mux.HandleFunc("/repos/o/r/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "t0"}})
	})
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "c1"})
	})
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n := treePosts + 1
		treePosts = n
		mu.Unlock()
		if n == 1 {
			// 404 but token HAS workflow scope -> fresh-repo lag, retry.
			w.Header().Set("X-OAuth-Scopes", "admin:org, gist, repo, workflow")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "t1"})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, io.Discard, "o", "r", "main", false); err != nil {
		t.Fatalf("commitSkeleton should retry a 404 when workflow scope is present: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if treePosts != 2 {
		t.Errorf("createTree called %d times, want 2 (retry the transient 404, then succeed)", treePosts)
	}
	if !patched {
		t.Error("ref was never PATCHed; the commit never landed")
	}
}

// TestCommitSkeleton_NotFoundWithoutScopeHeaderStillRetries: a 404 with
// no X-OAuth-Scopes header (a fine-grained PAT doesn't set it) is
// "unknown", not a missing-scope verdict -- it must fall back to the
// fresh-repo retry path and land, never fail fast.
func TestCommitSkeleton_NotFoundWithoutScopeHeaderStillRetries(t *testing.T) {
	var (
		mu        sync.Mutex
		treePosts int
		patched   bool
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/contents/.github/workflows/publish-pages.yaml", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/repos/o/r/branches/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]string{"sha": "c0"}})
	})
	mux.HandleFunc("/repos/o/r/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "c0"}})
		case http.MethodPatch:
			mu.Lock()
			patched = true
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s on refs/heads/main", r.Method)
		}
	})
	mux.HandleFunc("/repos/o/r/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "t0"}})
	})
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "c1"})
	})
	mux.HandleFunc("/repos/o/r/git/trees", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n := treePosts + 1
		treePosts = n
		mu.Unlock()
		if n == 1 {
			// 404 with NO X-OAuth-Scopes header -> unknown, must not be
			// classified as a missing-scope error.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "t1"})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := commitSkeleton(client, strings.NewReader(""), &out, io.Discard, "o", "r", "main", false); err != nil {
		t.Fatalf("commitSkeleton should retry a 404 with no scope header: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if treePosts != 2 {
		t.Errorf("createTree called %d times, want 2 (unknown 404 retried, then succeeds)", treePosts)
	}
	if !patched {
		t.Error("ref was never PATCHed; the commit never landed")
	}
}
