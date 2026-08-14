package feedbackpr

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// metadataPath is the in-repo accept marker whose introducing commit anchors
// the frozen `feedback` base. Aliased to the shared contract constant so this
// fourth reader can't drift from the student CLI, the runner
// (ACCEPT_MARKER_PATH), and the web GUI.
const metadataPath = contract.MetadataPath

// errBaseMismatch marks the never-retryable poisoned-base case: the `feedback`
// branch is frozen at a commit other than the accept SHA (a student
// pre-created it), so only an org admin deleting the branch can fix it. The
// caller routes it to the distinct "blocked" bucket rather than the retryable
// "failed" one. errAlreadyExists marks the idempotent no-op (a Feedback PR
// already exists in some state) so the summary can count it apart from a fresh
// open.
var (
	errBaseMismatch  = errors.New("feedback base mismatch")
	errAlreadyExists = errors.New("feedback PR already exists")
)

func isBaseMismatch(err error) bool  { return errors.Is(err, errBaseMismatch) }
func isAlreadyExists(err error) bool { return errors.Is(err, errAlreadyExists) }

// feedbackPRAttempts / isFeedbackPRRetryable bound retries of the whole ensure
// against GitHub's post-create git-data lag. The ensure is idempotent (a PR in
// any state short-circuits, the base ref tolerates already-exists at the right
// SHA), so a retry after a partial write is safe. Mirrors the accept-side CLI
// (cli/gh-student/feedback_pr.go).
const feedbackPRAttempts = 3

func isFeedbackPRRetryable(err error) bool {
	if ghutil.IsHTTPNotFound(err) || ghutil.IsHTTPStatus(err, http.StatusConflict) {
		return true
	}
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	return ok && httpErr.StatusCode >= 500
}

// ensureFeedbackPullRequest opens the assignment's Feedback PR on org/repoName
// idempotently — base = the frozen `feedback` branch at the repo's accept
// commit, head = its default branch — retrying the whole sequence through
// GitHub's post-create git-data lag. Returns nil after opening a PR,
// errAlreadyExists when one already exists (no writes), errBaseMismatch when
// the `feedback` branch is frozen at the wrong SHA, or a transient error.
//
// Ports the accept-side flow (cli/gh-student/feedback_pr.go) to the teacher
// token and the teacher CLI's client (which has no Patch verb — PATCH goes
// through Request). Keep the GitHub-facing sequence in lockstep with that file
// and the runner's ensure_feedback_pr.py — but note two DELIBERATE divergences
// from the student port, so a future sync doesn't "fix" them back: (1) the
// success/exists/mismatch outcomes are returned as the errAlreadyExists /
// errBaseMismatch sentinels (the student side returns plain nil for "exists")
// so run()'s summary can bucket them; (2) verbose/UI reporting lives in the
// caller, not here. A parity guard would be a shared core returning a typed
// outcome; until then, treat any behavioral edit here as one to mirror in the
// student CLI and the runner.
//
// branch is the repo's settled default branch (the head the PR opens against),
// resolved once by the caller from the same repo-object read that gates
// not-accepted-yet, so this never re-fetches it.
func ensureFeedbackPullRequest(client githubapi.Client, org, repoName, branch, mode string) error {
	acceptSHA := memoizeSHA(func() (string, error) { return acceptCommitSHA(client, org, repoName) })

	var lastErr error
	for attempt := range feedbackPRAttempts {
		err := tryEnsureFeedbackPullRequest(client, org, repoName, branch, mode, acceptSHA)
		if err == nil || isAlreadyExists(err) {
			return err
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

// memoizeSHA resolves at most once across retries; a failed resolution is not
// cached (it's one of the transient conditions the retry exists for).
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

func tryEnsureFeedbackPullRequest(client githubapi.Client, org, repoName, branch, mode string, resolveAcceptSHA func() (string, error)) error {
	if exists, err := feedbackPRExists(client, org, repoName, branch); err != nil {
		return err
	} else if exists {
		return errAlreadyExists
	}

	acceptSHA, err := resolveAcceptSHA()
	if err != nil {
		return err
	}
	if err := createFeedbackBaseRef(client, org, repoName, acceptSHA); err != nil {
		return err
	}

	prNumber, err := createFeedbackPR(client, org, repoName, branch)
	if err != nil {
		if !isNoCommitsBetween(err) {
			return feedbackPRRaceOr(client, org, repoName, branch, err)
		}
		// Zero diff is the normal case for an un-pushed repo: GitHub refuses a
		// PR with no commits between base and head, so land one empty commit
		// (same tree; `[skip ci]` keeps the shim quiet) and retry once.
		if err := pushFeedbackEmptyCommit(client, org, repoName, branch); err != nil {
			return err
		}
		prNumber, err = createFeedbackPR(client, org, repoName, branch)
		if err != nil {
			return feedbackPRRaceOr(client, org, repoName, branch, err)
		}
	}

	// Label best-effort: the PR is in place, so a label failure never fails
	// the step (mirrors the runner's check=False label step).
	_ = labelFeedbackPR(client, org, repoName, prNumber, mode)
	return nil
}

// feedbackPRRaceOr swallows createErr when the PR turns out to exist after all
// (two concurrent opens can both pass the existence probe; the loser gets a 422
// "already exists"). The original error survives when the re-query finds
// nothing, so a genuine failure is never masked. Mirrors the runner's
// existing_pr_url re-query.
func feedbackPRRaceOr(client githubapi.Client, org, repoName, branch string, createErr error) error {
	if exists, err := feedbackPRExists(client, org, repoName, branch); err == nil && exists {
		return errAlreadyExists
	}
	return createErr
}

// acceptCommitSHA recovers the accept commit — the oldest commit touching the
// .classroom50.yaml marker — via the commits API, the same rule the web GUI's
// getOldestCommitShaForPath uses. Both are checkout-less API clients, so they
// approximate the runner's git-side baseline_sha() (which uses
// `git log --reverse --first-parent --diff-filter=A`, i.e. the oldest commit
// that *added* the marker on the mainline). The two agree in the normal
// single-add case; they can differ only when the marker is deleted-and-readded
// or added off the mainline, in which case the runner's base-SHA check refuses
// to adopt the frozen branch (a mismatch an org admin resolves). The history is
// walked to exhaustion rather than trusting one page — a wrong (newer) SHA is
// worse than a slow read once the marker's history exceeds one page.
func acceptCommitSHA(client githubapi.Client, org, repoName string) (string, error) {
	commits, err := githubapi.PaginateAll[struct {
		SHA string `json:"sha"`
	}](client, 100, 100, func(page int) string {
		return fmt.Sprintf("repos/%s/%s/commits?path=%s&per_page=100&page=%d",
			url.PathEscape(org), url.PathEscape(repoName),
			url.QueryEscape(metadataPath), page)
	}, nil)
	if err != nil {
		return "", err
	}
	if len(commits) == 0 {
		return "", fmt.Errorf("no commits touch %s in %s/%s", metadataPath, org, repoName)
	}
	// Newest-first, so the last entry is the accept commit.
	return commits[len(commits)-1].SHA, nil
}

// feedbackPRExists reports whether a Feedback PR (base=feedback, head=branch)
// exists in ANY state. Closed/merged count: reopening is teacher/runner
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

// createFeedbackBaseRef freezes the `feedback` branch at the accept commit. An
// already-existing ref is only adopted once it READS BACK at acceptSHA: the org
// ruleset locks updates/deletion but leaves creation open, so a student can
// pre-create `feedback` at a commit of their choosing; opening the PR over that
// base would hand the teacher a diff the student picked. A mismatch returns
// errBaseMismatch (routed to the blocked bucket).
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
		return fmt.Errorf("%w: %s branch is at %s, not the expected baseline %s — an org admin must delete it so it can be re-frozen correctly",
			errBaseMismatch, contract.FeedbackBaseBranch, sha, acceptSHA)
	}
	return nil
}

// branchTipSHA reads one branch's tip via the SINGULAR git/ref/heads/<branch>
// endpoint: the plural form matches by prefix, so a branch whose name prefixes
// another would silently resolve to the wrong ref.
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

// createFeedbackPR opens the Feedback PR and returns its number. Title and body
// come from the shared contract, so whichever side creates the PR (accept
// clients or the runner's fallback), teachers see one coherent body.
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
// commits between feedback and main") — the signal to land the empty commit and
// retry.
func isNoCommitsBetween(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	return ok && has422Message(httpErr, "no commits between")
}

// pushFeedbackEmptyCommit fast-forwards `branch` by one empty commit (same tree
// as the current head) so a zero-diff Feedback PR has a commit to exist on.
// force stays false: losing the ref race to a student's instant first push
// means the runner opens the PR on that submission instead — overwriting their
// work is never acceptable. The teacher client has no Patch verb, so the ref
// update goes through Request(PATCH).
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
	resp, err := client.Request(http.MethodPatch, patchPath, bytes.NewReader(patchBody))
	if err != nil {
		return fmt.Errorf("PATCH %s: %w", patchPath, err)
	}
	_ = resp.Body.Close()
	return nil
}

// labelFeedbackPR pins the mode label on the PR, creating the label first so
// its color matches the runner's. Both steps tolerate already-exists; the
// caller treats any error as non-fatal.
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

// is422AlreadyExists / has422Message classify GitHub's 422s by message text
// (the only signal — errors[].code is the generic "custom"). Local copies of
// the accept-side helpers (cli/gh-student/accept.go).
func is422AlreadyExists(httpErr *githubapi.HTTPError) bool {
	return has422Message(httpErr, "already exists")
}

func has422Message(httpErr *githubapi.HTTPError, needle string) bool {
	return httpErr.StatusCode == http.StatusUnprocessableEntity &&
		httpErrorMentions(httpErr, needle)
}

// httpErrorMentions reports whether needle (lower-case) appears in the error's
// top-level message or any Errors[] item; GitHub puts the reason in either slot
// depending on the endpoint.
func httpErrorMentions(httpErr *githubapi.HTTPError, needle string) bool {
	if strings.Contains(strings.ToLower(httpErr.Message), needle) {
		return true
	}
	for _, item := range httpErr.Errors {
		if strings.Contains(strings.ToLower(item.Message), needle) {
			return true
		}
	}
	return false
}
