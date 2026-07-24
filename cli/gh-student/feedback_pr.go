package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/ui"
)

// ensureFeedbackPullRequest opens the assignment's Feedback PR at accept time
// (issue #228): base = the frozen `feedback` branch at the accept commit, head
// = the repo's default branch. Creating it here — with the student's own token
// — means the PR exists even when GitHub Actions is disabled; when Actions IS
// on, the autograde runner (ensure_feedback_pr.py) discovers the PR by
// base+head and adopts it instead of creating its own.
//
// Best-effort BY CONTRACT: every failure returns an error for the caller to
// warn on, never to fail the accept — a classroom bootstrapped by an older
// `gh teacher init` (no feedback-base ruleset), a permissions oddity, or a
// race with an instant first push must not break accepting. The runner
// remains the fallback creator on the first submission.
//
// Idempotent: a PR in ANY state (open/closed/merged) short-circuits before
// any write, so a re-accept never duplicates the PR or its empty commit, and
// never reopens a PR a teacher or the runner has since closed/merged.
//
// Mirrors the GUI's ensureFeedbackPullRequest
// (web/src/domain/assignments/feedbackPr.ts) — keep behavior in lockstep.
func ensureFeedbackPullRequest(client githubapi.Client, u *ui.UI, verbose bool, org, repoName, branch, acceptSHA, mode string) error {
	if exists, err := feedbackPRExists(client, org, repoName, branch); err != nil {
		return err
	} else if exists {
		if verbose {
			u.Detail("feedback PR already exists on %s/%s; leaving it as-is", org, repoName)
		}
		return nil
	}

	if err := createFeedbackBaseRef(client, org, repoName, acceptSHA); err != nil {
		return err
	}

	prNumber, err := createFeedbackPR(client, org, repoName, branch)
	if err != nil {
		if !isNoCommitsBetween(err) {
			return err
		}
		// Zero diff at accept time is the normal case: GitHub refuses a PR
		// with no commits between base and head, so land one empty commit
		// (same tree; `[skip ci]` keeps the shim quiet) and retry once. If a
		// prior interrupted accept already landed the empty commit but died
		// before the PR, the first POST above succeeds and this path is
		// skipped — no second empty commit.
		if err := pushFeedbackEmptyCommit(client, org, repoName, branch); err != nil {
			return err
		}
		prNumber, err = createFeedbackPR(client, org, repoName, branch)
		if err != nil {
			return err
		}
	}

	// Label best-effort (mirrors the runner's check=False label step): the PR
	// is in place, so a label failure is detail-level, not warn-level.
	if err := labelFeedbackPR(client, org, repoName, prNumber, mode); err != nil && verbose {
		u.Detail("could not label feedback PR #%d on %s/%s: %v", prNumber, org, repoName, err)
	}
	return nil
}

// feedbackPRExists reports whether a Feedback PR (base=feedback, head=branch)
// exists in ANY state. Closed/merged count: reopening is runner/teacher
// territory, and a re-created PR would demand a second empty commit.
func feedbackPRExists(client githubapi.Client, org, repoName, branch string) (bool, error) {
	path := fmt.Sprintf("repos/%s/%s/pulls?base=%s&head=%s&state=all&per_page=1",
		url.PathEscape(org), url.PathEscape(repoName),
		url.QueryEscape(contract.FeedbackBaseBranch),
		url.QueryEscape(org+":"+branch))
	var prs []struct {
		Number int `json:"number"`
	}
	if err := client.Get(path, &prs); err != nil {
		return false, fmt.Errorf("GET %s: %w", path, err)
	}
	return len(prs) > 0, nil
}

// createFeedbackBaseRef freezes the `feedback` branch at the accept commit —
// the same baseline the runner resolves from the .classroom50.yaml marker, so
// its base-SHA check adopts this branch as its own. "Reference already
// exists" is a healthy re-run (or the runner got there first), not an error.
func createFeedbackBaseRef(client githubapi.Client, org, repoName, acceptSHA string) error {
	body, err := json.Marshal(map[string]string{
		"ref": "refs/heads/" + contract.FeedbackBaseBranch,
		"sha": acceptSHA,
	})
	if err != nil {
		return fmt.Errorf("encoding feedback ref body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/git/refs", url.PathEscape(org), url.PathEscape(repoName))
	if err := client.Post(path, bytes.NewReader(body), nil); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok && is422AlreadyExists(httpErr) {
			return nil
		}
		return fmt.Errorf("POST %s: %w", path, err)
	}
	return nil
}

// createFeedbackPR opens the Feedback PR and returns its number. Title and
// body are byte-identical with the runner's (contract package), so whichever
// side creates the PR, teachers and backfill_release_link see the same thing.
func createFeedbackPR(client githubapi.Client, org, repoName, branch string) (int, error) {
	releaseURL := fmt.Sprintf("https://github.com/%s/%s/releases/latest", org, repoName)
	body, err := json.Marshal(map[string]string{
		"base":  contract.FeedbackBaseBranch,
		"head":  branch,
		"title": contract.FeedbackPRTitle,
		"body":  contract.FeedbackPRBody(branch, releaseURL),
	})
	if err != nil {
		return 0, fmt.Errorf("encoding feedback PR body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/pulls", url.PathEscape(org), url.PathEscape(repoName))
	var created struct {
		Number int `json:"number"`
	}
	if err := client.Post(path, bytes.NewReader(body), &created); err != nil {
		return 0, fmt.Errorf("POST %s: %w", path, err)
	}
	return created.Number, nil
}

// isNoCommitsBetween matches GitHub's 422 refusal of a zero-diff PR ("No
// commits between feedback and main"). Message-substring matching is the only
// discriminator GitHub offers — the errors[].code is the generic "custom".
func isNoCommitsBetween(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok {
		return false
	}
	if strings.Contains(strings.ToLower(httpErr.Message), "no commits between") {
		return true
	}
	for _, item := range httpErr.Errors {
		if strings.Contains(strings.ToLower(item.Message), "no commits between") {
			return true
		}
	}
	return false
}

// pushFeedbackEmptyCommit fast-forwards `branch` by one empty commit (same
// tree as the current head) so a zero-diff Feedback PR has a commit to exist
// on. force stays false: losing the ref race to a student's instant first
// push means the runner will open the PR on that submission instead —
// overwriting their work is never acceptable.
func pushFeedbackEmptyCommit(client githubapi.Client, org, repoName, branch string) error {
	refPath := fmt.Sprintf("repos/%s/%s/git/ref/heads/%s",
		url.PathEscape(org), url.PathEscape(repoName), url.PathEscape(branch))
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := client.Get(refPath, &ref); err != nil {
		return fmt.Errorf("GET %s: %w", refPath, err)
	}

	commitPath := fmt.Sprintf("repos/%s/%s/git/commits/%s",
		url.PathEscape(org), url.PathEscape(repoName), url.PathEscape(ref.Object.SHA))
	var head struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := client.Get(commitPath, &head); err != nil {
		return fmt.Errorf("GET %s: %w", commitPath, err)
	}

	createBody, err := json.Marshal(map[string]any{
		"message": contract.FeedbackOpenCommitMessage(),
		"tree":    head.Tree.SHA,
		"parents": []string{ref.Object.SHA},
	})
	if err != nil {
		return fmt.Errorf("encoding empty commit body: %w", err)
	}
	createPath := fmt.Sprintf("repos/%s/%s/git/commits", url.PathEscape(org), url.PathEscape(repoName))
	var created struct {
		SHA string `json:"sha"`
	}
	if err := client.Post(createPath, bytes.NewReader(createBody), &created); err != nil {
		return fmt.Errorf("POST %s: %w", createPath, err)
	}

	patchBody, err := json.Marshal(map[string]any{"sha": created.SHA, "force": false})
	if err != nil {
		return fmt.Errorf("encoding ref update body: %w", err)
	}
	patchPath := fmt.Sprintf("repos/%s/%s/git/refs/heads/%s",
		url.PathEscape(org), url.PathEscape(repoName), url.PathEscape(branch))
	if err := client.Patch(patchPath, bytes.NewReader(patchBody), nil); err != nil {
		return fmt.Errorf("PATCH %s: %w", patchPath, err)
	}
	return nil
}

// labelFeedbackPR pins the mode label on the PR, creating the label first so
// its color matches the runner's (adding a nonexistent label to an issue
// would auto-create it with a random color). Both steps tolerate
// already-exists; the caller treats any error as detail-level.
func labelFeedbackPR(client githubapi.Client, org, repoName string, prNumber int, mode string) error {
	name, color := contract.FeedbackLabelForMode(mode)

	labelBody, err := json.Marshal(map[string]string{
		"name":        name,
		"color":       color,
		"description": "Classroom 50 teacher-managed feedback PR",
	})
	if err != nil {
		return fmt.Errorf("encoding label body: %w", err)
	}
	labelPath := fmt.Sprintf("repos/%s/%s/labels", url.PathEscape(org), url.PathEscape(repoName))
	if err := client.Post(labelPath, bytes.NewReader(labelBody), nil); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); !ok || !is422AlreadyExists(httpErr) {
			return fmt.Errorf("POST %s: %w", labelPath, err)
		}
	}

	addBody, err := json.Marshal(map[string][]string{"labels": {name}})
	if err != nil {
		return fmt.Errorf("encoding add-labels body: %w", err)
	}
	addPath := fmt.Sprintf("repos/%s/%s/issues/%d/labels",
		url.PathEscape(org), url.PathEscape(repoName), prNumber)
	if err := client.Post(addPath, bytes.NewReader(addBody), nil); err != nil {
		return fmt.Errorf("POST %s: %w", addPath, err)
	}
	return nil
}
