// Package gittree holds the git Tree-commit plumbing shared by the gh-teacher
// and gh-student CLIs: upload blobs, build a tree over a base_tree, create a
// commit, move a ref. Both modules had byte-near-identical copies; this is the
// single source.
//
// Two retry policies sit on top, because the two callers face different
// hazards:
//
//   - CommitWithRebase — optimistic update with non-fast-forward retry, for
//     writes to a repo with *concurrent writers* (the teacher's
//     <org>/classroom50 config repo).
//   - CommitWithFreshRepoRetry — retry the tree+commit build against a
//     *freshly-created* repo whose ref/git-data APIs briefly 404/409 until they
//     propagate (the teacher's first skeleton land; the student's accept-time
//     control-file commit).
//
// TreeEntry.SHA is a pointer so a nil value marshals to `"sha":null`, which the
// Trees API treats as "remove this path from base_tree" (see DeletionEntries).
// Callers that never delete simply never build a nil entry.
package gittree

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
)

// ErrNonFastForward: PATCH was rejected because the new commit isn't a
// descendant of the current branch tip. CommitWithRebase retries on it.
var ErrNonFastForward = errors.New("non-fast-forward ref update")

// rebaseAttempts: 5 tries at 200ms × 2^n backoff (~3s) — absorbs concurrent
// CLI invocations, fails fast on a wedged repo.
const rebaseAttempts = 5

// TreeEntry is one entry in a git Tree create request. SHA is a pointer so a
// nil value marshals to `"sha":null`, which the Trees API treats as "remove
// this path from base_tree" (see DeletionEntries). Upserts carry a non-nil blob
// SHA from UploadBlobs.
type TreeEntry struct {
	Path string  `json:"path"`
	Mode string  `json:"mode"`
	Type string  `json:"type"`
	SHA  *string `json:"sha"`
}

// Change describes the mutations for a single commit: Upserts (path -> new
// content) are created or overwritten; Deletes (repo-root-relative paths) are
// removed from the tree. An empty change is a no-op.
type Change struct {
	Upserts map[string]string
	Deletes []string
}

func (c Change) isEmpty() bool {
	return len(c.Upserts) == 0 && len(c.Deletes) == 0
}

// RefAndTree returns (parentCommitSHA, parentTreeSHA) for branch. parentTreeSHA
// becomes the new tree's `base_tree` so unchanged paths inherit without
// re-uploading.
func RefAndTree(client *api.RESTClient, owner, repo, branch string) (commitSHA, treeSHA string, err error) {
	refPath := fmt.Sprintf("repos/%s/%s/git/refs/heads/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	var refResp struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := client.Get(refPath, &refResp); err != nil {
		return "", "", fmt.Errorf("GET %s: %w", refPath, err)
	}

	commitPath := fmt.Sprintf("repos/%s/%s/git/commits/%s",
		url.PathEscape(owner), url.PathEscape(repo), refResp.Object.SHA)
	var commitResp struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := client.Get(commitPath, &commitResp); err != nil {
		return "", "", fmt.Errorf("GET %s: %w", commitPath, err)
	}
	return refResp.Object.SHA, commitResp.Tree.SHA, nil
}

// UploadBlobs creates one blob per file and returns the tree entries. Always
// base64-encoded; simpler than per-file encoding detection, with negligible
// overhead.
func UploadBlobs(client *api.RESTClient, owner, repo string, files map[string]string) ([]TreeEntry, error) {
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	entries := make([]TreeEntry, 0, len(files))
	blobPath := fmt.Sprintf("repos/%s/%s/git/blobs", url.PathEscape(owner), url.PathEscape(repo))
	for _, p := range paths {
		body, err := json.Marshal(struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}{
			Content:  base64.StdEncoding.EncodeToString([]byte(files[p])),
			Encoding: "base64",
		})
		if err != nil {
			return nil, fmt.Errorf("encode blob %s: %w", p, err)
		}
		var blobResp struct {
			SHA string `json:"sha"`
		}
		if err := client.Post(blobPath, bytes.NewReader(body), &blobResp); err != nil {
			return nil, fmt.Errorf("POST %s (%s): %w", blobPath, p, err)
		}
		sha := blobResp.SHA
		entries = append(entries, TreeEntry{
			Path: p,
			Mode: "100644",
			Type: "blob",
			SHA:  &sha,
		})
	}
	return entries, nil
}

// DeletionEntries builds tree entries that remove `paths` from base_tree. A nil
// SHA marshals to `"sha":null`, which the Trees API treats as a deletion. Paths
// are sorted for a deterministic payload. Git prunes trees left empty by the
// deletions, so only blob paths need listing.
func DeletionEntries(paths []string) []TreeEntry {
	if len(paths) == 0 {
		return nil
	}
	sorted := append([]string(nil), paths...)
	sort.Strings(sorted)
	entries := make([]TreeEntry, 0, len(sorted))
	for _, p := range sorted {
		entries = append(entries, TreeEntry{Path: p, Mode: "100644", Type: "blob", SHA: nil})
	}
	return entries
}

// CreateTree posts a tree over baseTreeSHA. classify404, if non-nil, receives
// the raw error on a 404 POST and may return a terminal error to surface
// instead (the teacher uses this to tell a missing-`workflow`-scope 404 from
// fresh-repo lag). Returning nil (or a nil func) leaves the original error
// intact.
func CreateTree(client *api.RESTClient, owner, repo, baseTreeSHA string, entries []TreeEntry, classify404 func(error) error) (string, error) {
	body, err := json.Marshal(struct {
		BaseTree string      `json:"base_tree"`
		Tree     []TreeEntry `json:"tree"`
	}{
		BaseTree: baseTreeSHA,
		Tree:     entries,
	})
	if err != nil {
		return "", fmt.Errorf("encode tree: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/git/trees", url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		SHA string `json:"sha"`
	}
	if err := client.Post(path, bytes.NewReader(body), &resp); err != nil {
		if classify404 != nil && ghutil.IsHTTPStatus(err, http.StatusNotFound) {
			if mapped := classify404(err); mapped != nil {
				return "", fmt.Errorf("POST %s: %w", path, mapped)
			}
		}
		return "", fmt.Errorf("POST %s: %w", path, err)
	}
	return resp.SHA, nil
}

// CreateCommit posts a commit with the given tree and single parent.
func CreateCommit(client *api.RESTClient, owner, repo, treeSHA, parentSHA, message string) (string, error) {
	body, err := json.Marshal(struct {
		Message string   `json:"message"`
		Tree    string   `json:"tree"`
		Parents []string `json:"parents"`
	}{
		Message: message,
		Tree:    treeSHA,
		Parents: []string{parentSHA},
	})
	if err != nil {
		return "", fmt.Errorf("encode commit: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/git/commits", url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		SHA string `json:"sha"`
	}
	if err := client.Post(path, bytes.NewReader(body), &resp); err != nil {
		return "", fmt.Errorf("POST %s: %w", path, err)
	}
	return resp.SHA, nil
}

// UpdateRef force-moves branch to commitSHA via a plain PATCH (error on any
// non-200). Use when there are no concurrent writers; for the contended case
// use CommitWithRebase, which routes through PatchRef.
func UpdateRef(client *api.RESTClient, owner, repo, branch, commitSHA string) error {
	body, err := json.Marshal(struct {
		SHA string `json:"sha"`
	}{SHA: commitSHA})
	if err != nil {
		return fmt.Errorf("encode ref update: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/git/refs/heads/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	resp, err := client.Request(http.MethodPatch, path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("PATCH %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PATCH %s: unexpected status %d", path, resp.StatusCode)
	}
	return nil
}

// PatchRef returns ErrNonFastForward on a race so CommitWithRebase can tell
// "retry" from "real failure". 422 alone isn't enough (GitHub also uses it for
// permission failures and malformed refs); matching the message text keeps
// retries from papering over real failures.
func PatchRef(client *api.RESTClient, owner, repo, branch, commitSHA string) error {
	body, err := json.Marshal(struct {
		SHA string `json:"sha"`
	}{SHA: commitSHA})
	if err != nil {
		return fmt.Errorf("encode ref update: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/git/refs/heads/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	resp, err := client.Request(http.MethodPatch, path, bytes.NewReader(body))
	if err == nil {
		defer func() { _ = resp.Body.Close() }()
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("PATCH %s: unexpected status %d", path, resp.StatusCode)
		}
		return nil
	}
	var httpErr *api.HTTPError
	if errors.As(err, &httpErr) &&
		httpErr.StatusCode == http.StatusUnprocessableEntity &&
		isNonFastForwardMessage(httpErr.Message) {
		return fmt.Errorf("PATCH %s: %w (%s)", path, ErrNonFastForward, httpErr.Message)
	}
	return fmt.Errorf("PATCH %s: %w", path, err)
}

// isNonFastForwardMessage matches GitHub's "Update is not a fast forward"
// rejection (with hyphen / casing tolerance).
func isNonFastForwardMessage(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "fast forward") || strings.Contains(lower, "fast-forward")
}

// CommitWithRebase is the optimistic-update-with-rebase helper for writes to a
// repo that may have concurrent writers. build is invoked per attempt with the
// parent commit SHA so it sees the current state of every path it upserts or
// deletes. classify404 is forwarded to CreateTree (nil if the caller has no 404
// specialization).
//
// Return shape:
//   - ("<sha>", nil) — commit landed.
//   - ("", nil)      — build returned an empty change; no-op.
//   - ("", err)      — failure (build can signal one via (_, err)).
//
// Reset any per-attempt accumulators at the top of each build call so a retry
// doesn't see stale state.
func CommitWithRebase(
	client *api.RESTClient,
	owner, repo, branch, message string,
	build func(parentSHA string) (Change, error),
	classify404 func(error) error,
) (string, error) {
	for attempt := 0; attempt < rebaseAttempts; attempt++ {
		parentSHA, parentTreeSHA, err := RefAndTree(client, owner, repo, branch)
		if err != nil {
			return "", err
		}

		change, err := build(parentSHA)
		if err != nil {
			return "", err
		}
		if change.isEmpty() {
			return "", nil
		}

		entries, err := UploadBlobs(client, owner, repo, change.Upserts)
		if err != nil {
			return "", err
		}
		entries = append(entries, DeletionEntries(change.Deletes)...)

		treeSHA, err := CreateTree(client, owner, repo, parentTreeSHA, entries, classify404)
		if err != nil {
			return "", err
		}
		commitSHA, err := CreateCommit(client, owner, repo, treeSHA, parentSHA, message)
		if err != nil {
			return "", err
		}

		err = PatchRef(client, owner, repo, branch, commitSHA)
		if err == nil {
			return commitSHA, nil
		}
		if !errors.Is(err, ErrNonFastForward) {
			return "", err
		}

		// Concurrent writer won; back off before retrying. Skip the sleep after
		// the final attempt — it would just delay the error.
		if attempt < rebaseAttempts-1 {
			time.Sleep(ghutil.BackoffDelay(attempt))
		}
	}
	return "", fmt.Errorf("%s/%s on %s lost the rebase race %d times; retry the command or investigate concurrent writers", owner, repo, branch, rebaseAttempts)
}

// FreshRepoRetry configures CommitWithFreshRepoRetry. It targets a
// freshly-created repo whose ref/git-data APIs briefly 404/409 until they
// propagate — distinct from the concurrent-writer race CommitWithRebase covers.
type FreshRepoRetry struct {
	// Attempts is the number of read-parent + build-tree tries.
	Attempts int
	// ValidateParent, if non-nil, inspects the parent SHAs from RefAndTree
	// before the tree build; a (retryable) error here lets the loop ride out a
	// ref that reads 200 with an empty SHA. Optional.
	ValidateParent func(parentSHA, parentTreeSHA string) error
	// Classify404 is forwarded to CreateTree (e.g. the teacher's
	// missing-workflow-scope terminal mapping). Optional.
	Classify404 func(error) error
	// IsRetryable decides whether an error from the read+build is worth another
	// attempt (e.g. 404/409/empty-ref). Required — a nil func makes every error
	// terminal.
	IsRetryable func(error) bool
}

// CommitWithFreshRepoRetry builds the tree+commit for `entries` over `branch`'s
// current tip and force-moves the ref, retrying the read+build (not the ref
// move) while the repo's git-data APIs lag. Blobs are content-addressed, so the
// caller uploads them once (via UploadBlobs) and passes the entries; a retry
// reuses the same SHAs.
//
// Returns the landed commit SHA. No no-op case: callers pass a non-empty entry
// set.
func CommitWithFreshRepoRetry(
	client *api.RESTClient,
	owner, repo, branch, message string,
	entries []TreeEntry,
	cfg FreshRepoRetry,
) (string, error) {
	commitSHA, err := buildCommit(client, owner, repo, branch, message, entries, cfg)
	if err != nil {
		return "", err
	}
	if err := UpdateRef(client, owner, repo, branch, commitSHA); err != nil {
		return "", err
	}
	return commitSHA, nil
}

// buildCommit reads the parent, builds the tree+commit, and returns the
// not-yet-referenced commit SHA, retrying per cfg while the fresh repo lags.
func buildCommit(
	client *api.RESTClient,
	owner, repo, branch, message string,
	entries []TreeEntry,
	cfg FreshRepoRetry,
) (string, error) {
	var err error
	for i := 0; i < cfg.Attempts; i++ {
		var parentSHA, parentTreeSHA string
		parentSHA, parentTreeSHA, err = RefAndTree(client, owner, repo, branch)
		if err == nil && cfg.ValidateParent != nil {
			err = cfg.ValidateParent(parentSHA, parentTreeSHA)
		}
		if err == nil {
			var treeSHA string
			if treeSHA, err = CreateTree(client, owner, repo, parentTreeSHA, entries, cfg.Classify404); err == nil {
				var commitSHA string
				if commitSHA, err = CreateCommit(client, owner, repo, treeSHA, parentSHA, message); err == nil {
					return commitSHA, nil
				}
			}
		}
		if cfg.IsRetryable == nil || !cfg.IsRetryable(err) || i == cfg.Attempts-1 {
			return "", err
		}
		time.Sleep(ghutil.BackoffDelay(i))
	}
	return "", err
}
