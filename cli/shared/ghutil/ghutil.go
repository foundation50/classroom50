// Package ghutil holds small, proven-duplicated helpers for talking to the
// GitHub API via go-gh, shared by the gh-teacher and gh-student CLIs. Not a
// client wrapper — go-gh's *api.RESTClient already is that; this only collects
// the primitives both modules had copied: HTTP-status classification and the
// retry backoff schedule.
package ghutil

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
)

// linkNextRe extracts the `rel="next"` target from a GitHub `Link` header, e.g.
//
//	<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"
//
// GitHub's guidance is to follow this URL rather than synthesize page numbers:
// page size and whether a next page exists are the server's to decide.
var linkNextRe = regexp.MustCompile(`<([^>]+)>\s*;\s*[^,]*rel="next"`)

// NextPageLink returns the `rel="next"` URL from a Link header, or "" when
// there is no next page (or no Link header). Shared by both CLIs' paginated
// walks so they follow GitHub's pagination contract identically.
func NextPageLink(header string) string {
	if header == "" {
		return ""
	}
	m := linkNextRe.FindStringSubmatch(header)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// NextPage centralizes the page-walk termination decision both Go CLIs rely
// on, so the error-prone predicate isn't re-implemented (and drifting) at each
// call site. Given a response's Link header, the just-decoded batch length, and
// the requested per-page size, it returns:
//
//   - (nextURL, false) — follow GitHub's `rel="next"` URL.
//   - ("", true)       — stop: Link header present without a `rel="next"` (last
//     page), or NO Link header (test server / Link-less endpoint) with a short
//     page (len < perPage, including empty).
//   - ("", false)      — no Link header AND a full page: the caller synthesizes
//     the next page (e.g. pageURL(page+1)) and continues.
//
// Callers own how they build a synthesized next page, so that URL isn't
// returned here; only the decision is shared.
func NextPage(linkHeader string, batchLen, perPage int) (nextURL string, stop bool) {
	if next := NextPageLink(linkHeader); next != "" {
		return next, false
	}
	if linkHeader != "" || batchLen < perPage {
		return "", true
	}
	return "", false
}

// IsHTTPStatus reports whether err is a *api.HTTPError with the given status
// code, collapsing the err -> *api.HTTPError -> StatusCode pattern used to
// tell 404/409/422 from transport errors.
func IsHTTPStatus(err error, code int) bool {
	httpErr, ok := errors.AsType[*api.HTTPError](err)
	return ok && httpErr.StatusCode == code
}

// IsHTTPNotFound reports whether err is a 404 *api.HTTPError.
func IsHTTPNotFound(err error) bool {
	return IsHTTPStatus(err, http.StatusNotFound)
}

// IsRateLimited reports whether err is a GitHub rate-limit / secondary-limit
// (abuse) response rather than a genuine permission denial. GitHub signals these
// with a `Retry-After` header (secondary limit / 429) or `x-ratelimit-remaining:
// 0` (primary limit), and they surface as 403 or 429 — indistinguishable from a
// real authz 403 by status code alone. Callers that treat a plain 403 as benign
// (e.g. "an owner must grant this") must exclude this case so a transient
// throttle stays a loud, non-zero-exit failure instead of silent guidance.
func IsRateLimited(err error) bool {
	httpErr, ok := errors.AsType[*api.HTTPError](err)
	if !ok {
		return false
	}
	if httpErr.StatusCode != http.StatusForbidden &&
		httpErr.StatusCode != http.StatusTooManyRequests {
		return false
	}
	if httpErr.Headers.Get("Retry-After") != "" ||
		httpErr.Headers.Get("X-RateLimit-Remaining") == "0" {
		return true
	}
	// Secondary limits may omit both headers while keeping remaining non-zero;
	// the only signal is then the body message (go-gh maps it to Message).
	msg := strings.ToLower(httpErr.Message)
	return strings.Contains(msg, "secondary rate limit") ||
		strings.Contains(msg, "abuse")
}

// BackoffDelay is the exponential backoff for optimistic-retry loops:
// 200ms * 2^attempt (attempt is 0-based), i.e. 200ms, 400ms, 800ms, ...
// Callers gate it (skip the sleep after the final attempt).
func BackoffDelay(attempt int) time.Duration {
	return time.Duration(200*(1<<attempt)) * time.Millisecond
}

// WaitForStableBranch polls until two consecutive reads agree on a non-empty
// commit SHA (max 20 attempts, ~10s). Needed against a freshly created/templated
// branch — the contents/git-data APIs briefly 409 "Git Repository is empty"
// until the ref propagates.
func WaitForStableBranch(client *api.RESTClient, owner, repo, branch string) error {
	path := fmt.Sprintf(
		"repos/%s/%s/branches/%s",
		url.PathEscape(owner),
		url.PathEscape(repo),
		url.PathEscape(branch),
	)
	var lastSHA string
	for i := range 20 {
		var resp struct {
			Commit struct {
				SHA string `json:"sha"`
			} `json:"commit"`
		}
		if err := client.Get(path, &resp); err != nil {
			lastSHA = "" // transient error; reset the baseline
			time.Sleep(time.Duration(250*(i+1)) * time.Millisecond)
			continue
		}
		if resp.Commit.SHA == "" {
			lastSHA = "" // no commit yet; reset the baseline
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if resp.Commit.SHA == lastSHA {
			return nil
		}
		lastSHA = resp.Commit.SHA
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("branch %s/%s:%s did not stabilize", owner, repo, branch)
}

// ResolveSettledDefaultBranch waits out GitHub's async template-copy lag and
// returns the branch that actually materialized. Right after POST .../generate,
// GET /repos reports a transient default_branch (the org default, e.g. `main`)
// while the real branch (copied from the template, e.g. `master`) hasn't been
// created yet — so trusting default_branch, or an immediate confirming GET,
// can pin a `heads/main` that never exists. This polls the repo's branch list
// until at least one ref exists, then returns the live default_branch when it
// names a real branch, else the sole/first materialized branch. Falls back to
// `fallback` if nothing materializes within the window.
// ResolveSettledDefaultBranch waits out GitHub's async template-copy lag and
// returns the branch that actually materialized. Right after POST .../generate,
// GET /repos reports a transient default_branch (the org default, e.g. `main`)
// while the real branch (copied from the template, e.g. `master`) hasn't been
// created yet — so trusting default_branch, or an immediate confirming GET,
// can pin a `heads/main` that never exists. This polls the repo's branch list
// up to `attempts` times (sleeping `delay*(i+1)` between tries) until at least
// one ref exists, then returns the live default_branch when it names a real
// branch, else the first materialized branch. Falls back to `fallback` if
// nothing materializes within the window.
func ResolveSettledDefaultBranch(client *api.RESTClient, owner, repo, fallback string, attempts int, delay time.Duration) string {
	repoPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	branchesPath := fmt.Sprintf("repos/%s/%s/branches?per_page=100", url.PathEscape(owner), url.PathEscape(repo))
	for i := range attempts {
		var branches []struct {
			Name string `json:"name"`
		}
		if err := client.Get(branchesPath, &branches); err == nil && len(branches) > 0 {
			names := make(map[string]bool, len(branches))
			for _, b := range branches {
				names[b.Name] = true
			}
			// Prefer the live default_branch when it names a branch that exists;
			// otherwise fall back to the first materialized branch.
			var repoResp struct {
				DefaultBranch string `json:"default_branch"`
			}
			if err := client.Get(repoPath, &repoResp); err == nil &&
				repoResp.DefaultBranch != "" && names[repoResp.DefaultBranch] {
				return repoResp.DefaultBranch
			}
			return branches[0].Name
		}
		time.Sleep(delay * time.Duration(i+1))
	}
	return fallback
}

// CurrentUser returns the authenticated user's login and immutable numeric ID
// via GET /user. Callers needing only the login can ignore the id (e.g.
// whoami); gh-student's identity.Fetch uses both to build the noreply email.
func CurrentUser(client *api.RESTClient) (login string, id int64, err error) {
	var user struct {
		Login string `json:"login"`
		ID    int64  `json:"id"`
	}
	if err := client.Get("user", &user); err != nil {
		return "", 0, fmt.Errorf("GET /user: %w", err)
	}
	return user.Login, user.ID, nil
}

// SetCollaborator PUTs username as a collaborator on owner/repo with the given
// permission and returns the HTTP status (201 = invitation created and awaiting
// acceptance, 204 = added directly). Callers format their own messages off the
// status; an unexpected status is an error.
func SetCollaborator(client *api.RESTClient, owner, repo, username, permission string) (int, error) {
	body, err := json.Marshal(map[string]string{"permission": permission})
	if err != nil {
		return 0, fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/collaborators/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(username))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return resp.StatusCode, fmt.Errorf("PUT %s: unexpected status %d", path, resp.StatusCode)
	}
	return resp.StatusCode, nil
}

// DecodeContentsBase64 decodes the base64 envelope the GitHub contents/git-data
// APIs return. They wrap at column 60 and Go's std decoder rejects embedded
// newlines, so strip them first.
func DecodeContentsBase64(content string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(strings.ReplaceAll(content, "\n", ""))
}
