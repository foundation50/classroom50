package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/ui"
)

// feedbackTemplateRef points the accept-time Feedback PR body at a template
// repo's native pull_request_template.md (feedback_pr_template opt-in).
type feedbackTemplateRef struct {
	owner, repo, branch string
}

// resolveFeedbackTemplateRef returns the template ref to read the Feedback PR
// body from, or nil when the assignment did not opt in (feedback_pr_template)
// or has no template. Only meaningful with FeedbackPR + a template.
func resolveFeedbackTemplateRef(entry assignments.Entry) *feedbackTemplateRef {
	if !entry.FeedbackPRTemplate || !entry.FeedbackPR || entry.Template == nil {
		return nil
	}
	branch := entry.Template.Branch
	if branch == "" {
		branch = "main"
	}
	return &feedbackTemplateRef{
		owner:  entry.Template.Owner,
		repo:   entry.Template.Repo,
		branch: branch,
	}
}

// readTemplatePRBody returns the teacher-supplied Feedback PR body for tmpl, or
// "" (ok=false) to fall back to the built-in body. Delegates the fail-open read
// to the shared ghutil helper; a nil ref means "built-in".
func readTemplatePRBody(client githubapi.Client, tmpl *feedbackTemplateRef) (string, bool) {
	if tmpl == nil {
		return "", false
	}
	return githubapi.ReadTemplatePRBody(client, tmpl.owner, tmpl.repo, tmpl.branch)
}

// ensureFeedbackPullRequest opens the assignment's Feedback PR at accept time
// (issue #228) — base = the frozen `feedback` branch at the accept commit, head
// = the repo's default branch — retrying the whole idempotent sequence through
// GitHub's post-create git-data lag.
//
// Creating it with the student's own token is what makes the PR exist when
// GitHub Actions is disabled; when Actions IS on, the autograde runner
// (ensure_feedback_pr.py) finds this PR by base+head and adopts it. Every
// failure returns an error for the caller to warn on, never to fail the accept.
//
// Mirrors the GUI's ensureFeedbackPullRequest
// (web/src/domain/assignments/feedbackPr.ts) — keep behavior in lockstep.
//
// resolveAcceptSHA is called lazily: on the dominant re-accept path a PR already
// exists, and resolving the SHA costs a paginated commit-history read whose
// result would be discarded.
func ensureFeedbackPullRequest(client githubapi.Client, u *ui.UI, verbose bool, org, repoName, branch, mode string, tmpl *feedbackTemplateRef, resolveAcceptSHA func() (string, error)) error {
	acceptSHA := memoizeSHA(resolveAcceptSHA)
	var lastErr error
	for attempt := range feedbackPRAttempts {
		err := tryEnsureFeedbackPullRequest(client, u, verbose, org, repoName, branch, mode, tmpl, acceptSHA)
		if err == nil {
			return nil
		}
		lastErr = err
		if !isFeedbackPRRetryable(err) {
			return err
		}
		if attempt < feedbackPRAttempts-1 {
			time.Sleep(ghutil.BackoffDelay(attempt))
		}
	}
	return lastErr
}

// memoizeSHA resolves at most once across the retry attempts, so a retry never
// re-reads the commit history. A failed resolution is not cached — it is one of
// the transient conditions the retry exists for.
func memoizeSHA(resolve func() (string, error)) func() (string, error) {
	var cached string
	return func() (string, error) {
		if cached != "" {
			return cached, nil
		}
		sha, err := resolve()
		if err != nil {
			return "", err
		}
		cached = sha
		return sha, nil
	}
}

// feedbackPRAttempts / isFeedbackPRRetryable bound retries of the whole ensure
// against GitHub's post-create git-data lag — the same window DropFiles rides
// out with commitFilesAttempts and verifyProvisioned polls through. Without it
// one transient 404/409/5xx leaves no PR at all, which in an Actions-disabled
// classroom is permanent. The ensure is idempotent (a PR in any state
// short-circuits, the base ref tolerates already-exists), so a retry after a
// partial write is safe.
const feedbackPRAttempts = 3

func isFeedbackPRRetryable(err error) bool {
	if ghutil.IsHTTPNotFound(err) || ghutil.IsHTTPStatus(err, http.StatusConflict) {
		return true
	}
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	return ok && httpErr.StatusCode >= 500
}

func tryEnsureFeedbackPullRequest(client githubapi.Client, u *ui.UI, verbose bool, org, repoName, branch, mode string, tmpl *feedbackTemplateRef, resolveAcceptSHA func() (string, error)) error {
	if exists, err := feedbackPRExists(client, org, repoName, branch); err != nil {
		return err
	} else if exists {
		if verbose {
			u.Detail("feedback PR already exists on %s/%s; leaving it as-is", org, repoName)
		}
		return nil
	}

	acceptSHA, err := resolveAcceptSHA()
	if err != nil {
		return err
	}
	if err := createFeedbackBaseRef(client, org, repoName, acceptSHA); err != nil {
		return err
	}

	prNumber, err := createFeedbackPR(client, org, repoName, branch, tmpl)
	if err != nil {
		if !isNoCommitsBetween(err) {
			return feedbackPRRaceOr(client, org, repoName, branch, err)
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
		prNumber, err = createFeedbackPR(client, org, repoName, branch, tmpl)
		if err != nil {
			return feedbackPRRaceOr(client, org, repoName, branch, err)
		}
	}

	// Label best-effort (mirrors the runner's check=False label step): the PR
	// is in place, so a label failure never fails the step. Reported
	// unconditionally, not just under --verbose — the runner's adoption path
	// never edits an existing PR, so it never repairs a missing label,
	// leaving an unlabeled PR nobody knows about.
	if err := labelFeedbackPR(client, org, repoName, prNumber, mode); err != nil {
		u.Detail("could not label feedback PR #%d on %s/%s: %v", prNumber, org, repoName, err)
	}
	return nil
}

// feedbackPRRaceOr swallows createErr when the PR turns out to exist after all.
// Two concurrent accepts (group members, or a re-accept racing the runner) can
// both pass the existence probe; the loser gets GitHub's "A pull request
// already exists" 422 and would otherwise warn the student that nothing was
// opened. Mirrors the runner's existing_pr_url re-query. The original error
// survives when the re-query finds nothing (or itself fails), so a genuine
// failure is never masked.
func feedbackPRRaceOr(client githubapi.Client, org, repoName, branch string, createErr error) error {
	if exists, err := feedbackPRExists(client, org, repoName, branch); err == nil && exists {
		return nil
	}
	return createErr
}

// openFeedbackPRStep runs the accept-time Feedback PR creation behind a
// spinner, converting any failure into a warning (the accept has already
// succeeded). Split out so both the fresh-provision and the healthy
// already-accepted paths report it identically.
func openFeedbackPRStep(client githubapi.Client, u *ui.UI, verbose bool, p acceptRepoParams, resolveAcceptSHA func() (string, error)) {
	const msg = "Opening feedback pull request"
	sp := u.Spinner(msg)
	sp.Start()
	if err := ensureFeedbackPullRequest(client, u, verbose, p.org, p.repoName, p.branch, p.mode, p.feedbackPRTemplate, resolveAcceptSHA); err != nil {
		sp.Fail(msg)
		u.Warn("%s: %v", feedbackPRDeferredHint, err)
		return
	}
	sp.Stop("Feedback pull request ready")
}

// feedbackPRDeferredHint names the remedy the student actually controls.
// Pointing only at "your first submission" would be false in exactly the
// Actions-disabled classroom this feature exists for — the runner never runs
// there, so re-accepting is the only route. Mirrors the GUI's deferred message.
const feedbackPRDeferredHint = "could not open the Feedback PR now; run accept again to retry (or it opens on your first submission if autograding is enabled)"

// acceptCommitSHA recovers the accept commit — the earliest commit touching
// the .classroom50.yaml marker — for a repo provisioned by an earlier accept.
// Same resolution rule as the runner's baseline_sha(), so the feedback base
// frozen here matches what the runner later verifies; a mismatch would strand
// the PR behind the runner's poisoned-base refusal, so the history is walked to
// exhaustion rather than trusting one page.
func acceptCommitSHA(client githubapi.Client, org, repoName string) (string, error) {
	commits, err := githubapi.PaginateAll[struct {
		SHA string `json:"sha"`
	}](client, 100, 100, func(page int) string {
		return fmt.Sprintf("repos/%s/%s/commits?path=%s&per_page=100&page=%d",
			url.PathEscape(org), url.PathEscape(repoName),
			url.QueryEscape(classroomcfg.MetadataPath), page)
	}, nil)
	if err != nil {
		return "", err
	}
	if len(commits) == 0 {
		return "", fmt.Errorf("no commits touch %s in %s/%s", classroomcfg.MetadataPath, org, repoName)
	}
	// Newest-first, so the last entry is the accept commit.
	return commits[len(commits)-1].SHA, nil
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
// its base-SHA check adopts this branch as its own.
//
// An already-existing ref is only adopted once it is READ BACK at acceptSHA.
// The ruleset gh teacher init deploys locks updates and deletion but leaves
// creation open, so a student can pre-create `feedback` at a commit of their
// choosing; opening the PR over that base would hand the teacher a grading
// diff the student picked. A mismatch therefore errors out (the caller
// downgrades it to a warning) and defers to the runner, whose
// existing_base_sha check refuses the same case and reports it as a failing
// commit status an org admin can act on.
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
			return verifyFeedbackBaseRef(client, org, repoName, acceptSHA)
		}
		return fmt.Errorf("POST %s: %w", path, err)
	}
	return nil
}

// verifyFeedbackBaseRef confirms the existing `feedback` branch points at
// acceptSHA. A read failure is NOT treated as a match: an unverifiable base is
// as unsafe as a wrong one (same rule as the runner's existing_base_sha, which
// raises on anything but a genuine 404).
func verifyFeedbackBaseRef(client githubapi.Client, org, repoName, acceptSHA string) error {
	sha, err := branchTipSHA(client, org, repoName, contract.FeedbackBaseBranch)
	if err != nil {
		return err
	}
	if sha != acceptSHA {
		return fmt.Errorf("%s branch is at %s, not the expected baseline %s — an org admin must delete it so it can be re-frozen correctly",
			contract.FeedbackBaseBranch, sha, acceptSHA)
	}
	return nil
}

// branchTipSHA reads one branch's tip. Uses the SINGULAR git/ref/heads/<branch>
// endpoint: the plural form matches by prefix and returns an array, so a branch
// whose name prefixes another would silently resolve to the wrong ref.
func branchTipSHA(client githubapi.Client, org, repoName, branch string) (string, error) {
	path := fmt.Sprintf("repos/%s/%s/git/ref/heads/%s",
		url.PathEscape(org), url.PathEscape(repoName), url.PathEscape(branch))
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := client.Get(path, &ref); err != nil {
		return "", fmt.Errorf("GET %s: %w", path, err)
	}
	return ref.Object.SHA, nil
}

// createFeedbackPR opens the Feedback PR and returns its number. The body is
// the teacher template (read verbatim from the template repo, best-effort) when
// tmpl is set and the file is readable, else the built-in body — byte-identical
// with the runner's (contract package), so teachers see one coherent body.
func createFeedbackPR(client githubapi.Client, org, repoName, branch string, tmpl *feedbackTemplateRef) (int, error) {
	releaseURL := fmt.Sprintf("https://github.com/%s/%s/releases/latest", org, repoName)
	prBody := contract.FeedbackPRBody(branch, releaseURL)
	if teacherBody, ok := readTemplatePRBody(client, tmpl); ok {
		prBody = teacherBody
	}
	body, err := json.Marshal(map[string]string{
		"base":  contract.FeedbackBaseBranch,
		"head":  branch,
		"title": contract.FeedbackPRTitle,
		"body":  prBody,
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
// commits between feedback and main") — the accept-time signal to land the
// empty commit and retry.
func isNoCommitsBetween(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	return ok && has422Message(httpErr, "no commits between")
}

// pushFeedbackEmptyCommit fast-forwards `branch` by one empty commit (same
// tree as the current head) so a zero-diff Feedback PR has a commit to exist
// on. force stays false: losing the ref race to a student's instant first
// push means the runner will open the PR on that submission instead —
// overwriting their work is never acceptable.
func pushFeedbackEmptyCommit(client githubapi.Client, org, repoName, branch string) error {
	headSHA, err := branchTipSHA(client, org, repoName, branch)
	if err != nil {
		return err
	}

	commitPath := fmt.Sprintf("repos/%s/%s/git/commits/%s",
		url.PathEscape(org), url.PathEscape(repoName), url.PathEscape(headSHA))
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
		"parents": []string{headSHA},
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
