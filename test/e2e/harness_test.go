//go:build e2e

// Package e2e is a live, end-to-end test harness for the Classroom 50
// CLIs. It builds the real gh-teacher / gh-student binaries, drives the
// teacher↔student happy path against a real throwaway GitHub org, and
// asserts the observable result via the GitHub REST API.
//
// It is gated on the `e2e` build tag AND on credentials: a plain
// `go test` (no tag, no env) builds/runs nothing. See README.md for the
// required env. NOTHING here mocks GitHub — every call hits the live API
// or the live CLI, so it only runs where the bot PATs are provisioned.
package e2e

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const apiBase = "https://api.github.com"

var httpClient = &http.Client{Timeout: 30 * time.Second}

// ---- low-level REST (no *testing.T, usable from TestMain) ----

// apiReq issues one authenticated REST call, retrying transient 5xx /
// secondary-rate-limit responses a few times. Returns the final status
// and body.
func apiReq(method, token, path string, body []byte) (int, []byte, error) {
	url := path
	if strings.HasPrefix(path, "/") {
		url = apiBase + path
	}
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, url, rdr)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			last = err
			time.Sleep(backoff(attempt))
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		// Retry transient server errors / rate limits. GitHub's secondary
		// rate limit typically asks for 60s+, more than our exponential cap,
		// so honor Retry-After (falling back to X-RateLimit-Reset) when the
		// server tells us how long to wait — otherwise a rate-limited run
		// exhausts retries before the limit clears and flakes.
		if resp.StatusCode >= 500 || resp.StatusCode == 429 ||
			(resp.StatusCode == 403 && isRateLimited(resp.Header, b)) {
			last = fmt.Errorf("%s %s: transient %d: %s", method, path, resp.StatusCode, b)
			time.Sleep(retryDelay(resp.Header, attempt))
			continue
		}
		return resp.StatusCode, b, nil
	}
	return 0, nil, last
}

func backoff(attempt int) time.Duration {
	return time.Duration(1<<attempt) * time.Second // 1s,2s,4s,8s,16s
}

// isRateLimited reports whether a 403 is a rate-limit rejection (secondary
// rate limit, or primary quota exhaustion signaled by x-ratelimit-remaining:0)
// rather than a genuine permission error.
func isRateLimited(h http.Header, body []byte) bool {
	if bytes.Contains(bytes.ToLower(body), []byte("secondary rate limit")) {
		return true
	}
	return h.Get("X-RateLimit-Remaining") == "0"
}

// retryDelay honors a server-provided Retry-After (seconds) or X-RateLimit-Reset
// (epoch seconds) when present, clamped to a sane ceiling, and never waits less
// than the exponential backoff for this attempt.
func retryDelay(h http.Header, attempt int) time.Duration {
	base := backoff(attempt)
	if ra := h.Get("Retry-After"); ra != "" {
		if secs, err := strconv.Atoi(strings.TrimSpace(ra)); err == nil && secs > 0 {
			return clampDelay(time.Duration(secs)*time.Second, base)
		}
	}
	if reset := h.Get("X-RateLimit-Reset"); reset != "" {
		if epoch, err := strconv.ParseInt(strings.TrimSpace(reset), 10, 64); err == nil {
			if d := time.Until(time.Unix(epoch, 0)); d > 0 {
				return clampDelay(d, base)
			}
		}
	}
	return base
}

func clampDelay(want, floor time.Duration) time.Duration {
	const ceiling = 90 * time.Second
	if want > ceiling {
		want = ceiling
	}
	if want < floor {
		return floor
	}
	return want
}

// whoami resolves the login that owns a token.
func whoami(token string) (string, error) {
	st, b, err := apiReq(http.MethodGet, token, "/user", nil)
	if err != nil {
		return "", err
	}
	if st != 200 {
		return "", fmt.Errorf("GET /user: %d: %s", st, b)
	}
	var u struct {
		Login string `json:"login"`
	}
	if err := json.Unmarshal(b, &u); err != nil {
		return "", err
	}
	return u.Login, nil
}

// orgRole returns the caller's role in org ("admin" == owner, "member").
func orgRole(token, org, login string) (string, error) {
	st, b, err := apiReq(http.MethodGet, token, "/orgs/"+org+"/memberships/"+login, nil)
	if err != nil {
		return "", err
	}
	if st != 200 {
		return "", fmt.Errorf("GET membership: %d: %s", st, b)
	}
	var m struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return "", err
	}
	return m.Role, nil
}

// tokenScopes reads the X-OAuth-Scopes header a classic PAT advertises.
func tokenScopes(token string) ([]string, error) {
	req, _ := http.NewRequest(http.MethodGet, apiBase+"/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	raw := resp.Header.Get("X-OAuth-Scopes")
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out, nil
}

// ---- binary build + invocation ----

// repoRoot is two levels up from the test package dir (test/e2e).
func repoRoot(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	return abs
}

// buildBinaries compiles gh-teacher and gh-student fresh from the branch
// under test into a temp dir (never trusting a pre-installed extension —
// that's the stale-binary class of bug). Called from TestMain.
func buildBinaries() error {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "c50-e2e-bin")
	if err != nil {
		return err
	}
	for name, pkg := range map[string]string{
		"gh-teacher": filepath.Join(root, "cli", "gh-teacher"),
		"gh-student": filepath.Join(root, "cli", "gh-student"),
	} {
		out := filepath.Join(dir, name)
		cmd := exec.Command("go", "build", "-o", out, ".")
		cmd.Dir = pkg
		cmd.Env = append(os.Environ(), "GOTOOLCHAIN=go1.26.4")
		if b, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("build %s: %v\n%s", name, err, b)
		}
		switch name {
		case "gh-teacher":
			teacherBin = out
		case "gh-student":
			studentBin = out
		}
	}
	return nil
}

// runCLI invokes a built CLI binary as the given identity (GH_TOKEN),
// optionally in workDir, with extra env. Returns combined stdout/stderr.
func runCLI(token, workDir string, extraEnv []string, bin string, args ...string) (string, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = workDir
	env := append(os.Environ(), "GH_TOKEN="+token, "GH_PROMPT_DISABLED=1")
	cmd.Env = append(env, extraEnv...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

// teacher runs gh-teacher as the teacher identity and fails the test on
// a non-zero exit.
func teacher(t *testing.T, args ...string) string {
	t.Helper()
	out, err := runCLI(cfg.TeacherPAT, "", nil, teacherBin, args...)
	if err != nil {
		t.Fatalf("gh-teacher %s\n%v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

// student runs gh-student as the given student token.
func student(t *testing.T, token string, args ...string) string {
	t.Helper()
	out, err := runCLI(token, "", nil, studentBin, args...)
	if err != nil {
		t.Fatalf("gh-student %s\n%v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

// teardownQuiet best-effort wipes the org (used first for a clean slate
// and last for cleanup). Ignores errors — a fresh org has nothing to
// delete and `teardown` no-ops when classroom50 is absent.
func teardownQuiet() {
	if teacherBin == "" {
		return
	}
	_, _ = runCLI(cfg.TeacherPAT, "", nil, teacherBin, "teardown", cfg.Org, "--yes")
}

// ---- REST assertions (with *testing.T) ----

func getJSON(t *testing.T, token, path string, v any) int {
	t.Helper()
	st, b, err := apiReq(http.MethodGet, token, path, nil)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	if v != nil && st >= 200 && st < 300 {
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatalf("decode %s: %v\n%s", path, err, b)
		}
	}
	return st
}

// getJSONPoll is the non-fatal variant for use inside waitFor closures: a
// transport error (apiReq exhausted its retries) is returned so the poll can
// keep trying until its own deadline, rather than aborting the whole step on a
// single transient blip.
func getJSONPoll(token, path string, v any) (int, error) {
	st, b, err := apiReq(http.MethodGet, token, path, nil)
	if err != nil {
		return 0, err
	}
	if v != nil && st >= 200 && st < 300 {
		if err := json.Unmarshal(b, v); err != nil {
			return st, fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return st, nil
}

// repoExists reports whether <org>/<repo> exists (200) for the token.
func repoExists(t *testing.T, token, repo string) bool {
	t.Helper()
	st := getJSON(t, token, "/repos/"+cfg.Org+"/"+repo, nil)
	return st == 200
}

// contentExists reports whether a path exists in a repo (contents API).
func contentExists(t *testing.T, token, repo, path string) bool {
	t.Helper()
	st := getJSON(t, token, "/repos/"+cfg.Org+"/"+repo+"/contents/"+path, nil)
	return st == 200
}

// feedbackPR is the slice element listFeedbackPRs returns: the open PRs whose
// base is the frozen `feedback` branch (issue #228 asserts exactly one across
// accept, re-accept, and runner adoption).
type feedbackPR struct {
	Number int `json:"number"`
	Base   struct {
		Ref string `json:"ref"`
	} `json:"base"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
}

// listFeedbackPRs returns the repo's OPEN PRs with base=feedback.
func listFeedbackPRs(t *testing.T, repo string) []feedbackPR {
	t.Helper()
	var pulls []feedbackPR
	getJSON(t, cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo+"/pulls?state=open&base=feedback", &pulls)
	return pulls
}

// fetchContent returns the decoded file at repo/path (contents API).
func fetchContent(t *testing.T, token, repo, path string) (string, bool) {
	t.Helper()
	var c struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	st := getJSON(t, token, "/repos/"+cfg.Org+"/"+repo+"/contents/"+path, &c)
	if st != 200 {
		return "", false
	}
	if c.Encoding == "base64" {
		dec, err := base64Decode(c.Content)
		if err != nil {
			t.Fatalf("decode %s/%s: %v", repo, path, err)
		}
		return dec, true
	}
	return c.Content, true
}

// collaboratorPermission returns the effective permission of login on a
// repo ("admin"/"maintain"/"push"/...), per the teacher token.
func collaboratorPermission(t *testing.T, repo, login string) string {
	t.Helper()
	var p struct {
		Permission string `json:"permission"`
		RoleName   string `json:"role_name"`
	}
	st := getJSON(t, cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo+"/collaborators/"+login+"/permission", &p)
	if st != 200 {
		t.Fatalf("permission %s on %s: status %d", login, repo, st)
	}
	if p.RoleName != "" {
		return p.RoleName
	}
	return p.Permission
}

// ---- polling ----

// waitFor polls fn until it returns true or the timeout elapses.
func waitFor(t *testing.T, desc string, timeout time.Duration, fn func() (bool, error)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		ok, err := fn()
		if err != nil {
			lastErr = err
		} else if ok {
			return
		}
		time.Sleep(5 * time.Second)
	}
	t.Fatalf("timed out after %s waiting for %s (last err: %v)", timeout, desc, lastErr)
}

// waitForRunSuccess polls runs of a workflow file in a repo, considering only
// runs created at/after `since` (capture it right before the triggering CLI
// call), and fails fast the moment the matched run reaches a terminal non-success
// conclusion. Pinning by `since` avoids asserting against a stale earlier run of
// the same workflow — every commit to classroom50 (classroom/roster/assignment
// add) triggers another publish-pages run, so "newest == ours" is not safe once
// the first trigger has fired.
func waitForRunSuccess(t *testing.T, repo, workflowFile string, since time.Time, timeout time.Duration) {
	t.Helper()
	// created:>=<ts> filters server-side; RFC3339 is what the runs API accepts.
	path := fmt.Sprintf("/repos/%s/%s/actions/workflows/%s/runs?per_page=1&created=%%3E%%3D%s",
		cfg.Org, repo, workflowFile, since.UTC().Format(time.RFC3339))
	waitFor(t, "run of "+workflowFile+" in "+repo, timeout, func() (bool, error) {
		var r struct {
			Runs []struct {
				Status     string `json:"status"`
				Conclusion string `json:"conclusion"`
				HTMLURL    string `json:"html_url"`
			} `json:"workflow_runs"`
		}
		st, err := getJSONPoll(cfg.TeacherPAT, path, &r)
		if err != nil {
			return false, err
		}
		if st != 200 || len(r.Runs) == 0 {
			return false, nil
		}
		run := r.Runs[0]
		if run.Status != "completed" {
			return false, nil
		}
		// A completed run's conclusion is terminal — a non-success will never
		// become success, so surface it immediately as a fatal (waitFor fails
		// fast on a non-nil error only via a dedicated terminal signal below),
		// not by spinning the full timeout.
		if run.Conclusion != "success" {
			t.Fatalf("run of %s in %s concluded %q: %s", workflowFile, repo, run.Conclusion, run.HTMLURL)
		}
		return true, nil
	})
}

// dispatchWorkflow triggers a workflow_dispatch with inputs.
func dispatchWorkflow(t *testing.T, repo, workflowFile, ref string, inputs map[string]string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"ref": ref, "inputs": inputs})
	st, b, err := apiReq(http.MethodPost, cfg.TeacherPAT,
		"/repos/"+cfg.Org+"/"+repo+"/actions/workflows/"+workflowFile+"/dispatches", body)
	if err != nil || st != 204 {
		t.Fatalf("dispatch %s: status %d err %v: %s", workflowFile, st, err, b)
	}
}

// waitForPages polls a public Pages URL until it serves 200 and the body
// contains `mustContain`. The last HTTP error / non-200 status is surfaced in
// the timeout message so a genuinely broken endpoint is distinguishable from
// slow first-deploy propagation.
func waitForPages(t *testing.T, url, mustContain string, timeout time.Duration) {
	t.Helper()
	waitFor(t, "Pages "+url, timeout, func() (bool, error) {
		resp, err := httpClient.Get(url)
		if err != nil {
			return false, err
		}
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 200 {
			return false, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
		}
		return strings.Contains(string(b), mustContain), nil
	})
}

// waitForReleaseAsset polls a repo's releases until one carries an asset with
// the given name. Shared by the happy-path and group flows.
func waitForReleaseAsset(t *testing.T, repo, assetName string, timeout time.Duration) {
	t.Helper()
	waitFor(t, "release with "+assetName+" in "+repo, timeout, func() (bool, error) {
		var rel []struct {
			Assets []struct {
				Name string `json:"name"`
			} `json:"assets"`
		}
		st, err := getJSONPoll(cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo+"/releases", &rel)
		if err != nil {
			return false, err
		}
		if st != 200 {
			return false, nil
		}
		for _, r := range rel {
			for _, a := range r.Assets {
				if a.Name == assetName {
					return true, nil
				}
			}
		}
		return false, nil
	})
}

func base64Decode(s string) (string, error) {
	// contents API wraps base64 at 76 cols with newlines.
	s = strings.ReplaceAll(s, "\n", "")
	b, err := base64.StdEncoding.DecodeString(s)
	return string(b), err
}
