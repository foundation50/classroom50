// Package configwrite is the config-repo write substrate: the
// optimistic-update-with-rebase Tree-commit helpers every teacher-side mutation
// of <org>/classroom50 goes through, plus the workflow-scope classifier wired
// into that loop. Write-side sibling of internal/configrepo (reads). Reaches
// GitHub only through internal/githubapi.
package configwrite

import (
	"github.com/foundation50/classroom50-cli-shared/gittree"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// CommitChange aliases gittree.Change: Upserts (path -> new content) are
// created or overwritten; Deletes (repo-root-relative paths) are removed from
// the tree. An empty change (no upserts, no deletes) is a no-op.
type CommitChange = gittree.Change

// CommitTree is the optimistic-update-with-rebase helper for teacher-side
// upserts. Covers the common upsert-only case (build returns a path → content
// map); for commits that also delete, use CommitTreeChange. The workflow-scope
// classifier is wired in so a `.github/workflows` write without the `workflow`
// scope fails fast.
//
// Return shape:
//   - ("<sha>", nil) — commit landed.
//   - ("", nil)      — build returned an empty map; no-op.
//   - ("", err)      — failure.
//
// Callers that close over a per-attempt accumulator must reset it at the top of
// each build call so a retry doesn't see stale state.
func CommitTree(
	client githubapi.Client,
	owner, repo, branch, message string,
	build func(parentSHA string) (map[string]string, error),
) (string, error) {
	return CommitTreeChange(client, owner, repo, branch, message,
		func(parentSHA string) (CommitChange, error) {
			files, err := build(parentSHA)
			if err != nil {
				return CommitChange{}, err
			}
			return CommitChange{Upserts: files}, nil
		})
}

// CommitTreeChange is CommitTree's deletion-aware core, delegating to the
// shared rebase loop. build is invoked per attempt with the parent commit SHA
// so it sees the current state of every path it intends to upsert or delete.
//
// Return shape matches CommitTree. Reset any per-attempt accumulators at the
// top of each build call so a retry doesn't see stale state.
func CommitTreeChange(
	client githubapi.Client,
	owner, repo, branch, message string,
	build func(parentSHA string) (CommitChange, error),
) (string, error) {
	return githubapi.CommitWithRebase(client, owner, repo, branch, message, build, ClassifyWorkflowScope404)
}
