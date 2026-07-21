package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/orgpolicy"
)

// plansThatSupportPrivatePages: GitHub plan slugs that allow Pages from a
// private source repo.
var plansThatSupportPrivatePages = map[string]bool{
	"team":          true,
	"business":      true,
	"business_plus": true,
	"enterprise":    true,
}

// applyOrgMemberDefaults applies the policies in one combined PATCH
// /orgs/{org}. On 403/422 (one plan-gated field sinks the whole PATCH) it
// falls back to one PATCH per policy. init completes either way.
//
// complete=true only when every *critical* lockdown field landed (the fields
// that defang the founder-admin grant org-wide). init warns "lockdown
// INCOMPLETE" when complete=false so a half-locked org isn't hidden.
func applyOrgMemberDefaults(client githubapi.Client, out, errOut io.Writer, org, plan string) (complete bool, unenforced []unenforcedSetting, err error) {
	settings := orgpolicy.MemberDefaultSettings(plan)
	combined := make(map[string]any, len(settings))
	for _, s := range settings {
		combined[s.Field] = s.Value
	}
	body, err := json.Marshal(combined)
	if err != nil {
		return false, nil, fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s", url.PathEscape(org))
	resp, err := client.Request(http.MethodPatch, path, bytes.NewReader(body))
	if err != nil {
		// A secondary-rate-limit 403 must not drop into the per-field
		// fallback — that fires one more PATCH per policy and amplifies the
		// throttle. Surface it as transient so a re-run retries.
		if isSecondaryRateLimit(err) {
			return false, nil, fmt.Errorf("PATCH %s: secondary rate limit (retry shortly): %w", path, err)
		}
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) || cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
			return applyOrgMemberDefaultsPerField(client, out, errOut, org, plan)
		}
		return false, nil, fmt.Errorf("PATCH %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	// go-gh returns non-2xx as err (handled above); this catches a stray 2xx.
	if resp.StatusCode != http.StatusOK {
		return false, nil, fmt.Errorf("PATCH %s: unexpected status %d", path, resp.StatusCode)
	}
	_, _ = fmt.Fprintf(out, "%s: org member defaults locked down (%s)\n", org, orgMemberDefaultsSummary(plan))
	// A 200 isn't proof the values stuck: enterprise-owned orgs accept the
	// PATCH but silently keep enterprise-pinned fields. Read the org back to
	// catch a silent no-op — the authoritative residual state.
	ok, unenforced := verifyOrgDefaults(client, errOut, org, plan)
	return ok, unenforced, nil
}

// unenforcedSetting is one org member-privilege policy whose live value
// doesn't match what init wants. It carries the exact GitHub-UI instruction
// (manualFix) so init can render one actionable "fix by hand" checklist.
type unenforcedSetting struct {
	field     string
	manualFix string
	critical  bool
}

// orgDefaultVerdict, classifyOrgDefaults and orgFieldMatches moved to
// internal/orgpolicy (the shared policy/classification seam consumed by
// both init's verifyOrgDefaults and audit's buildAuditReport).

// verifyOrgDefaults reads the org back and returns every member-default policy
// whose live value still doesn't match — whether the PATCH was rejected (422)
// or silently ignored (200-but-unchanged). This read-back is the authoritative
// source of truth (what the teacher sees in the settings UI). ok is true when
// nothing critical is unenforced. A read failure returns ok=true with one
// warning (the writes reported success; don't manufacture a false checklist).
func verifyOrgDefaults(client githubapi.Client, errOut io.Writer, org, plan string) (ok bool, unenforced []unenforcedSetting) {
	path := fmt.Sprintf("orgs/%s", url.PathEscape(org))
	var live map[string]any
	if err := client.Get(path, &live); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't read the org back to verify the member-privilege lockdown took effect (%v); spot-check https://github.com/organizations/%s/settings/member_privileges\n",
			org, err, org)
		return true, nil
	}

	verdicts, criticalMissed := orgpolicy.ClassifyDefaults(live, plan)
	for _, v := range verdicts {
		if v.Enforced {
			continue
		}
		unenforced = append(unenforced, unenforcedSetting{field: v.Setting.Field, manualFix: v.Setting.ManualFix, critical: v.Setting.Critical})
	}
	return !criticalMissed, unenforced
}

// unenforcedCause renders the plan-appropriate one-line reason init couldn't
// apply some member-privilege settings.
//
// On Team/Free plans (the common teacher case) GitHub doesn't expose these
// toggles via the org API, so the teacher applies them by hand. We
// deliberately do NOT suggest "upgrade to Enterprise Cloud" — most teachers
// can't switch plans, so that advice is noise. On Enterprise Cloud the fields
// are API-settable unless an enterprise owner pinned them (only they can
// change those). An unknown plan gets a neutral note.
func unenforcedCause(plan string) string {
	switch plan {
	case "enterprise":
		return "These are likely pinned at the enterprise level; an org owner can't change them from org settings — ask an enterprise owner, or set them by hand below."
	case "team", "free", "":
		return "GitHub doesn't expose these settings via the API on your plan, so set them by hand below."
	default:
		return "GitHub didn't apply these via the API; set them by hand below."
	}
}

// isSecondaryRateLimit reports whether err is GitHub's secondary rate-limit
// response (403, occasionally 429, mentioning "secondary rate limit"/"abuse").
// Distinct from a plan-gated field rejection (also 403): a plan-gated 403 warns
// "set it manually", but a rate-limit 403 is transient (retry), not a field to
// toggle by hand.
func isSecondaryRateLimit(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok {
		return false
	}
	if httpErr.StatusCode != http.StatusForbidden && httpErr.StatusCode != http.StatusTooManyRequests {
		return false
	}
	msg := strings.ToLower(httpErr.Message)
	return strings.Contains(msg, "secondary rate limit") || strings.Contains(msg, "abuse")
}

// orgMemberDefaultsSummary renders the applied policies straight from
// orgpolicy.MemberDefaultSettings(plan) so the success line can't drift from
// the canonical slice. Reports the count and joins each setting's `desc`.
func orgMemberDefaultsSummary(plan string) string {
	settings := orgpolicy.MemberDefaultSettings(plan)
	descs := make([]string, 0, len(settings))
	for _, s := range settings {
		descs = append(descs, s.Desc)
	}
	return fmt.Sprintf("%d policies: %s", len(settings), strings.Join(descs, "; "))
}

// applyOrgMemberDefaultsPerField is the 403/422 fallback: one PATCH per policy
// so one plan-gated field can't sink the others. It does NOT warn per rejection
// — the authoritative residual state comes from the read-back at the end
// (verifyOrgDefaults). A transient (non-403/422) error mid-loop aborts init but
// first reports which policies landed and which were never attempted, since the
// org is left partially mutated.
func applyOrgMemberDefaultsPerField(client githubapi.Client, out, errOut io.Writer, org, plan string) (complete bool, unenforced []unenforcedSetting, err error) {
	path := fmt.Sprintf("orgs/%s", url.PathEscape(org))
	settingsURL := fmt.Sprintf("https://github.com/organizations/%s/settings/member_privileges", org)
	settings := orgpolicy.MemberDefaultSettings(plan)
	var applied []string
	for i, s := range settings {
		body, encErr := json.Marshal(map[string]any{s.Field: s.Value})
		if encErr != nil {
			return false, nil, fmt.Errorf("encode body: %w", encErr)
		}
		resp, reqErr := client.Request(http.MethodPatch, path, bytes.NewReader(body))
		if reqErr != nil {
			// A secondary-rate-limit 403 isn't a plan-gated rejection:
			// retrying per-field amplifies the throttle. Report partial state
			// and abort so a re-run can finish cleanly.
			if isSecondaryRateLimit(reqErr) {
				reportPartialMemberDefaults(errOut, org, settings, applied, i, settingsURL)
				return false, nil, fmt.Errorf("PATCH %s: secondary rate limit: %w", path, reqErr)
			}
			if cliutil.IsHTTPStatus(reqErr, http.StatusForbidden) || cliutil.IsHTTPStatus(reqErr, http.StatusUnprocessableEntity) {
				// Plan-gated: don't warn here; the read-back reports the true
				// residual state as one checklist.
				continue
			}
			// Transient/unexpected (429/5xx/network): the org is partially
			// mutated. Report what landed and what wasn't attempted, so the
			// teacher can finish manually or re-run from a known state.
			reportPartialMemberDefaults(errOut, org, settings, applied, i, settingsURL)
			return false, nil, fmt.Errorf("PATCH %s: %w", path, reqErr)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			reportPartialMemberDefaults(errOut, org, settings, applied, i, settingsURL)
			return false, nil, fmt.Errorf("PATCH %s: unexpected status %d", path, resp.StatusCode)
		}
		applied = append(applied, s.Desc)
	}
	if len(applied) > 0 {
		_, _ = fmt.Fprintf(out, "%s: org member defaults set (%s)\n", org, strings.Join(applied, ", "))
	}
	// The read-back is the single source of truth for what didn't land (both
	// 422 rejections and 200-but-silently-ignored fields), so init renders one
	// checklist instead of per-field warnings.
	ok, unenforced := verifyOrgDefaults(client, errOut, org, plan)
	return ok, unenforced, nil
}

// reportPartialMemberDefaults warns that a transient error left the org
// lockdown half-applied, naming the policies that landed and those at failedIdx
// onward that weren't attempted, so a teacher can reconcile or re-run.
func reportPartialMemberDefaults(errOut io.Writer, org string, settings []orgpolicy.MemberDefaultSetting, applied []string, failedIdx int, settingsURL string) {
	notAttempted := make([]string, 0, len(settings)-failedIdx)
	for _, s := range settings[failedIdx:] {
		notAttempted = append(notAttempted, s.Desc)
	}
	appliedList := "none"
	if len(applied) > 0 {
		appliedList = strings.Join(applied, ", ")
	}
	_, _ = fmt.Fprintf(errOut,
		"Warning: %s: org member-privilege lockdown was left PARTIALLY APPLIED by a transient error. Applied: %s. Not yet attempted (including the field that errored): %s. The org is in a half-locked state — re-run `gh teacher init` to finish, or set the remaining policies at %s.\n",
		org, appliedList, strings.Join(notAttempted, ", "), settingsURL)
}

// ensureOrgActionsBudgetCap reconciles the org's $0 GitHub Actions spending
// cap. It's create-only: if no conforming Actions budget exists it POSTs the
// desired $0 hard-stop cap; it NEVER modifies or deletes a teacher-set budget
// (GitHub allows one budget per scope+SKU, and overriding the teacher's choice
// would be surprising — audit surfaces the verdict instead).
//
// Create-only and never fatal: the budget cap is a guardrail, not a
// prerequisite for the classroom to work. Returns the reconciliation status
// for the summary (see initSummary.BudgetCap for the values).
func ensureOrgActionsBudgetCap(client githubapi.Client, out, errOut io.Writer, org string) string {
	settingsURL := orgpolicy.OrgBudgetsURL(org)

	budgets, err := githubapi.ListOrgBudgets(client, org)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't read org billing budgets (%v); this usually means the token lacks Organization permissions -> Administration: Read, or the org/plan doesn't expose budgets. Set a $0 GitHub Actions budget by hand at %s to hard-stop paid Actions minutes.\n",
			org, err, settingsURL)
		return "unreadable"
	}

	switch v := orgpolicy.ClassifyBudget(budgets); v.Tier {
	case orgpolicy.BudgetEnforced, orgpolicy.BudgetOK:
		_, _ = fmt.Fprintf(out, "%s: Actions budget cap already in place ($%d)\n", org, v.Amount)
		return "present"
	case orgpolicy.BudgetWarn:
		_, _ = fmt.Fprintf(errOut, "Warning: %s: an Actions budget over $%d ($%d) is set; leaving it untouched — lower it to $0 at %s to hard-stop paid Actions minutes.\n",
			org, orgpolicy.BudgetWarnThreshold, v.Amount, settingsURL)
		return "warn"
	case orgpolicy.BudgetMissing:
		// Fall through to create below.
	}

	status, err := githubapi.CreateOrgActionsBudgetCap(client, org)
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't create the $0 Actions budget cap (%v); add Organization permissions -> Administration: Read and write to your token, or create the $0 GitHub Actions budget by hand at %s.\n",
				org, err, settingsURL)
			return "failed"
		}
		_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't create the $0 Actions budget cap (%v); create it by hand at %s.\n",
			org, err, settingsURL)
		return "failed"
	}
	if status != http.StatusCreated && status != http.StatusOK {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: creating the $0 Actions budget cap returned HTTP %d; create it by hand at %s.\n",
			org, status, settingsURL)
		return "failed"
	}
	_, _ = fmt.Fprintf(out, "%s: created a $0 GitHub Actions budget cap (blocks paid Actions minutes)\n", org)
	return "created"
}

// orgActionsPermissions is the subset of GET /orgs/{org}/actions/permissions
// that we read.
type orgActionsPermissions struct {
	EnabledRepositories string `json:"enabled_repositories"`
}

// ensureOrgActionsEnabled turns Actions on for the org when it's off org-wide
// ("none" → PUT "all"); Classroom50's workflows never run otherwise. "all" →
// noop; "selected"/unknown → warn. Read failures and a rejected enable
// (403/409/422, usually enterprise-locked) warn and continue.
func ensureOrgActionsEnabled(client githubapi.Client, out, errOut io.Writer, org string) error {
	path := fmt.Sprintf("orgs/%s/actions/permissions", url.PathEscape(org))

	var perms orgActionsPermissions
	if err := client.Get(path, &perms); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't read Actions permissions (%v); make sure GitHub Actions is enabled for the org at https://github.com/organizations/%s/settings/actions — Classroom50's autograde, publish-pages, and collect-scores workflows won't run without it.\n",
			org, err, org)
		return nil
	}

	switch perms.EnabledRepositories {
	case "all":
		_, _ = fmt.Fprintf(out, "%s: Actions already enabled (all repositories)\n", org)
		return nil
	case "selected":
		_, _ = fmt.Fprintf(errOut, "Warning: %s: Actions is enabled only for selected repositories; ensure the classroom50 config repo and the <classroom>-* student repos are included (or switch to All repositories) at https://github.com/organizations/%s/settings/actions — Classroom50's autograde, publish-pages, and collect-scores workflows won't run in any repo left out.\n",
			org, org)
		return nil
	case "none":
		// Off org-wide — enable below.
	default:
		// Empty/unknown: warn, don't touch the policy.
		_, _ = fmt.Fprintf(errOut, "Warning: %s: unexpected Actions enabled_repositories value %q; leaving it unchanged — verify GitHub Actions is enabled for the org at https://github.com/organizations/%s/settings/actions, or Classroom50's workflows may not run.\n",
			org, perms.EnabledRepositories, org)
		return nil
	}

	body, err := json.Marshal(struct {
		EnabledRepositories string `json:"enabled_repositories"`
	}{EnabledRepositories: "all"})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) || cliutil.IsHTTPStatus(err, http.StatusConflict) || cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't enable GitHub Actions (%v); this is often an enterprise-level policy an org admin can't override — ask an enterprise admin to enable Actions for the org at https://github.com/organizations/%s/settings/actions. Classroom50 workflows won't run until then.\n",
				org, err, org)
			return nil
		}
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: PUT /actions/permissions returned HTTP %d while enabling Actions; enable it manually at https://github.com/organizations/%s/settings/actions\n",
			org, resp.StatusCode, org)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s: Actions enabled (all repositories)\n", org)
	return nil
}

// orgWorkflowPermissions is the subset of
// /orgs/{org}/actions/permissions/workflow that we read/write.
type orgWorkflowPermissions struct {
	DefaultWorkflowPermissions   string `json:"default_workflow_permissions"`
	CanApprovePullRequestReviews bool   `json:"can_approve_pull_request_reviews"`
}

// ensureOrgCanCreatePRs turns on the org-level "Allow GitHub Actions to create
// and approve pull requests". The opt-in Feedback PR is opened by each student
// repo's workflow using GITHUB_TOKEN; even with `pull-requests: write`, GitHub
// rejects the creation unless can_approve_pull_request_reviews is on (defaults
// off). Student repos inherit this from the org, and a `maintain` collaborator
// can't set it per-repo, so the org is the only lever. Preserves
// default_workflow_permissions. 403/409 (enterprise-locked) → warn and
// continue.
//
// Trade-off: GitHub's single field couples "create" and "approve" — no
// create-only toggle, so this also lets Actions *approve* PRs org-wide. Safe as
// shipped: neither the config repo's default branch nor student repos have a
// required-review gate, so a self-approval grants no merge a student couldn't
// already do. Residual: if a teacher later adds a required-review rule, a
// student-controlled token could satisfy it via self-approval (documented in
// the wiki).
func ensureOrgCanCreatePRs(client githubapi.Client, out, errOut io.Writer, org string) (bool, error) {
	path := fmt.Sprintf("orgs/%s/actions/permissions/workflow", url.PathEscape(org))

	var current orgWorkflowPermissions
	if err := client.Get(path, &current); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: GET /actions/permissions/workflow failed (%v); GitHub Actions may be blocked from opening Feedback PRs. Enable \"Allow GitHub Actions to create and approve pull requests\" at https://github.com/organizations/%s/settings/actions\n", org, err, org)
		return false, nil
	}
	if current.CanApprovePullRequestReviews {
		_, _ = fmt.Fprintf(out, "%s: Actions already allowed to create pull requests\n", org)
		return true, nil
	}

	body, err := json.Marshal(orgWorkflowPermissions{
		DefaultWorkflowPermissions:   current.DefaultWorkflowPermissions,
		CanApprovePullRequestReviews: true,
	})
	if err != nil {
		return false, fmt.Errorf("encode body: %w", err)
	}

	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) || cliutil.IsHTTPStatus(err, http.StatusConflict) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: couldn't enable Actions-created pull requests (%v); the opt-in Feedback PR won't open until an org admin turns on \"Allow GitHub Actions to create and approve pull requests\" at https://github.com/organizations/%s/settings/actions\n", org, err, org)
			return false, nil
		}
		return false, fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		return false, fmt.Errorf("PUT %s: unexpected status %d", path, resp.StatusCode)
	}
	_, _ = fmt.Fprintf(out, "%s: enabled Actions to create pull requests (for Feedback PRs)\n", org)
	return true, nil
}

// repoActionsPermissions is the subset of GET
// /repos/{owner}/{repo}/actions/permissions that we read.
type repoActionsPermissions struct {
	Enabled bool `json:"enabled"`
}

// ensureRepoActionsEnabled turns Actions back on for a single repo disabled at
// the repo level (`enabled` false → PUT true), independent of the org setting.
// A read failure or rejected enable (403/409/422, usually org/enterprise
// policy) warns and continues.
func ensureRepoActionsEnabled(client githubapi.Client, out, errOut io.Writer, owner, repo string) error {
	path := fmt.Sprintf("repos/%s/%s/actions/permissions", url.PathEscape(owner), url.PathEscape(repo))

	var perms repoActionsPermissions
	if err := client.Get(path, &perms); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: couldn't read Actions permissions (%v); make sure Actions is enabled at https://github.com/%s/%s/settings/actions — Classroom50's publish-pages and collect-scores workflows won't run without it.\n",
			owner, repo, err, owner, repo)
		return nil
	}
	if perms.Enabled {
		_, _ = fmt.Fprintf(out, "%s/%s: Actions already enabled\n", owner, repo)
		return nil
	}

	body, err := json.Marshal(struct {
		Enabled bool `json:"enabled"`
	}{Enabled: true})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) || cliutil.IsHTTPStatus(err, http.StatusConflict) || cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: couldn't enable Actions (%v); this is often an org or enterprise policy — enable it at https://github.com/%s/%s/settings/actions. Classroom50's publish-pages and collect-scores workflows won't run until then.\n",
				owner, repo, err, owner, repo)
			return nil
		}
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: PUT /actions/permissions returned HTTP %d while enabling Actions; enable it manually at https://github.com/%s/%s/settings/actions\n",
			owner, repo, resp.StatusCode, owner, repo)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: Actions enabled\n", owner, repo)
	return nil
}

// checkOrgPlan was removed: the org plan is read once in preflight and its
// advisory surfaced there, so init no longer makes a second GET /orgs/{org}.

// ensureConfigRepo returns the classroom50 repo for <org>, creating it if
// absent. 422 → name taken; fall back to GET so re-runs succeed.
// default_branch flows through so an org policy rename doesn't break bootstrap.
func ensureConfigRepo(client githubapi.Client, org string) (repo configrepo.ConfigRepo, created bool, err error) {
	body, err := json.Marshal(struct {
		Name     string `json:"name"`
		Private  bool   `json:"private"`
		AutoInit bool   `json:"auto_init"`
	}{
		Name:     configrepo.ConfigRepoName,
		Private:  true,
		AutoInit: true,
	})
	if err != nil {
		return configrepo.ConfigRepo{}, false, fmt.Errorf("encode body: %w", err)
	}

	createPath := fmt.Sprintf("orgs/%s/repos", url.PathEscape(org))
	if err := client.Post(createPath, bytes.NewReader(body), &repo); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
			getPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), configrepo.ConfigRepoName)
			if getErr := client.Get(getPath, &repo); getErr != nil {
				return configrepo.ConfigRepo{}, false, fmt.Errorf("GET %s: %w", getPath, getErr)
			}
			return repo, false, nil
		}
		return configrepo.ConfigRepo{}, false, fmt.Errorf("POST %s: %w", createPath, err)
	}
	return repo, true, nil
}

// enablePages turns on Actions-built Pages and sets the site public — the
// student CLIs and the runner workflow fetch assignments.json, runner.py, the
// per-classroom autograder.py, and per-assignment bundles unauthenticated.
// 409 on create → "already enabled"; the visibility PUT fires either way so
// re-runs reconcile a previously-private site. Success on `out`; the
// visibility step warns to `errOut` if the API rejects it.
func enablePages(client githubapi.Client, out, errOut io.Writer, owner, repo string) error {
	body, err := json.Marshal(struct {
		BuildType string `json:"build_type"`
	}{BuildType: "workflow"})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/pages", url.PathEscape(owner), url.PathEscape(repo))
	switch err := client.Post(path, bytes.NewReader(body), nil); {
	case err == nil:
		_, _ = fmt.Fprintf(out, "%s/%s: Pages enabled (build_type=workflow)\n", owner, repo)
	case cliutil.IsHTTPStatus(err, http.StatusConflict):
		_, _ = fmt.Fprintf(out, "%s/%s: Pages already enabled\n", owner, repo)
	default:
		return fmt.Errorf("POST %s: %w", path, err)
	}
	return setPagesPublic(client, out, errOut, owner, repo)
}

// isPrivatePagesUnsupported reports whether err is the HTTP 400 GitHub returns
// when the plan has no Pages visibility control: "Private pages is not enabled
// for this repository. All Pages will be public." Visibility control is
// Enterprise-Cloud-only; every other plan is unconditionally public — exactly
// what init wants, so this is a success, not a warning.
func isPrivatePagesUnsupported(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	return ok && httpErr.StatusCode == http.StatusBadRequest &&
		strings.Contains(httpErr.Message, "Private pages is not enabled")
}

// setPagesPublic PUTs `{"public": true}` to /pages. The field isn't in the
// public OpenAPI body schema but the endpoint accepts it (same field the UI's
// Visibility radio drives). 204 → success; the no-visibility-control 400 (see
// isPrivatePagesUnsupported) is also success; any other status warns to
// `errOut` and returns nil so a quirky org policy doesn't fail init.
func setPagesPublic(client githubapi.Client, out, errOut io.Writer, owner, repo string) error {
	body, err := json.Marshal(struct {
		Public bool `json:"public"`
	}{Public: true})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/pages", url.PathEscape(owner), url.PathEscape(repo))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		if isPrivatePagesUnsupported(err) {
			_, _ = fmt.Fprintf(out, "%s/%s: Pages visibility is public (plan default; visibility controls require GitHub Enterprise Cloud)\n",
				owner, repo)
			return nil
		}
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: couldn't set Pages visibility to public (%v); toggle it manually at https://github.com/%s/%s/settings/pages → Visibility if students see 404s on the Pages URL\n",
			owner, repo, err, owner, repo)
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: PUT /pages returned HTTP %d while setting visibility; toggle it manually at https://github.com/%s/%s/settings/pages → Visibility if students see 404s on the Pages URL\n",
			owner, repo, resp.StatusCode, owner, repo)
		return nil
	}
	// A 204 doesn't prove the value stuck: `public` is undocumented and an
	// org/enterprise policy could pin visibility. Read it back — warn-only,
	// and a read failure is silent (the PUT reported success), mirroring the
	// org-lockdown read-back.
	if public, known := readPagesPublic(client, owner, repo); known && !public {
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: set Pages visibility to public but a read-back shows it still private — likely pinned by an org or enterprise policy. Students fetch assignments.json unauthenticated, so a private Pages site breaks `gh student accept`. Set it manually at https://github.com/%s/%s/settings/pages → Visibility.\n",
			owner, repo, owner, repo)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: Pages visibility set to public\n", owner, repo)
	return nil
}

// readPagesPublic GETs the repo Pages config and returns whether the site is
// public. known=false on any read failure so the caller treats an unverifiable
// read-back as non-blocking.
func readPagesPublic(client githubapi.Client, owner, repo string) (public, known bool) {
	path := fmt.Sprintf("repos/%s/%s/pages", url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		Public bool `json:"public"`
	}
	if err := client.Get(path, &resp); err != nil {
		return false, false
	}
	return resp.Public, true
}

// applyBranchProtection sets minimal protection on the default branch: no
// force-pushes, no deletions. PR-required is deliberately off —
// collect-scores.yaml and the CLI Tree-API writes both target the default
// branch directly and would be blocked. Force-push + delete blocking bounds the
// blast radius of an account compromise.
func applyBranchProtection(client githubapi.Client, out io.Writer, owner, repo, branch string) error {
	// Classic branch protection requires the four null fields present (not
	// omitted); a JSON literal beats juggling pointer types.
	body := []byte(`{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}`)
	path := fmt.Sprintf("repos/%s/%s/branches/%s/protection",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PUT %s: unexpected status %d", path, resp.StatusCode)
	}
	_, _ = fmt.Fprintf(out, "%s/%s: branch protection applied to %s (no force-push, no delete)\n", owner, repo, branch)
	return nil
}

// feedbackBaseBranch is the frozen PR base the Feedback PR feature pins at each
// student repo's baseline commit. Kept in lockstep with the autograde-runner
// workflow's BASE_BRANCH.
const feedbackBaseBranch = "feedback"

// Stable ruleset names so re-running init is idempotent —
// ensureClassroomRulesets reconciles an existing ruleset (by name) in place.
const (
	rulesetNameSubmissionHistory = "classroom50-protect-submission-history"
	rulesetNameFeedbackBase      = "classroom50-feedback-base-lock"
)

// orgRulesetBody is the POST /orgs/{org}/rulesets payload. Only the
// fields we set are modeled.
type orgRulesetBody struct {
	Name         string               `json:"name"`
	Target       string               `json:"target"`
	Enforcement  string               `json:"enforcement"`
	Conditions   rulesetConditions    `json:"conditions"`
	BypassActors []rulesetBypassActor `json:"bypass_actors"`
	Rules        []rulesetRule        `json:"rules"`
}

type rulesetConditions struct {
	RefName        refPatternCondition `json:"ref_name"`
	RepositoryName refPatternCondition `json:"repository_name"`
}

// refPatternCondition is GitHub's include/exclude shape, reused for ref_name
// and repository_name. "~ALL" (repos) and "~DEFAULT_BRANCH" (refs) are the
// documented wildcards.
type refPatternCondition struct {
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
}

// rulesetBypassActor lets an actor skip the rules. OrganizationAdmin
// (actor_id 1) is the org-owner role — the teacher — so they can merge the
// Feedback PR and force-push/delete in a pinch while students (maintain, no
// bypass) cannot.
type rulesetBypassActor struct {
	ActorID    int    `json:"actor_id"`
	ActorType  string `json:"actor_type"`
	BypassMode string `json:"bypass_mode"`
}

type rulesetRule struct {
	Type string `json:"type"`
}

// ensureClassroomRulesets installs two org-level branch rulesets covering
// every current and future repo (the student assignment repos), powering the
// Feedback PR feature:
//
//  1. submission history — on the default branch: block force-push + deletion
//     so a student can't rewrite/erase submission history; normal
//     fast-forward submits still go through.
//  2. feedback-base lock — on the `feedback` branch: restrict updates + block
//     deletion so students (maintain) can't merge or move the frozen PR base.
//     Branch *creation* stays allowed so the runner's GITHUB_TOKEN can create
//     it once; org admins bypass, so the teacher can merge the PR.
//
// Org-level rulesets need an org-admin token (gh teacher authenticates as org
// owner) — the workflow GITHUB_TOKEN has no administration scope, which is why
// this lives here, not in the runner. Idempotent AND reconciling: an existing
// ruleset (by name) is PUT to the current definition, repairing a stale one
// from an older CLI. Warn-and-continue on any failure.
func ensureClassroomRulesets(client githubapi.Client, out, errOut io.Writer, org string) (bool, error) {
	existing, err := listOrgRulesets(client, org)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not list org rulesets (%v); skipping Feedback PR branch protections. Apply them manually at https://github.com/organizations/%s/settings/rules if students can force-push submissions or merge feedback PRs.\n",
			org, err, org)
		return false, nil
	}

	adminBypass := []rulesetBypassActor{{ActorID: 1, ActorType: "OrganizationAdmin", BypassMode: "always"}}
	allRepos := refPatternCondition{Include: []string{"~ALL"}, Exclude: []string{}}

	rulesets := []orgRulesetBody{
		{
			Name:        rulesetNameSubmissionHistory,
			Target:      "branch",
			Enforcement: "active",
			Conditions: rulesetConditions{
				// ~DEFAULT_BRANCH follows each repo's actual default branch
				// (not hardcoded `main`) so it still covers repos renamed by
				// org policy — and matches the branch the Feedback PR opens
				// against.
				RefName:        refPatternCondition{Include: []string{"~DEFAULT_BRANCH"}, Exclude: []string{}},
				RepositoryName: allRepos,
			},
			BypassActors: adminBypass,
			// non_fast_forward blocks force-push; deletion blocks delete.
			// Neither blocks a normal fast-forward submit.
			Rules: []rulesetRule{{Type: "non_fast_forward"}, {Type: "deletion"}},
		},
		{
			Name:        rulesetNameFeedbackBase,
			Target:      "branch",
			Enforcement: "active",
			Conditions: rulesetConditions{
				RefName:        refPatternCondition{Include: []string{"refs/heads/" + feedbackBaseBranch}, Exclude: []string{}},
				RepositoryName: allRepos,
			},
			BypassActors: adminBypass,
			// `update` restricts pushes/merges to bypass actors (only the
			// teacher); `deletion` blocks delete. Creation stays allowed so
			// the runner can land the branch once.
			Rules: []rulesetRule{{Type: "update"}, {Type: "deletion"}},
		},
	}

	allReady := true
	for _, rs := range rulesets {
		if id, ok := existing[rs.Name]; ok {
			// Reconcile: PUT the current definition so a re-run picks up a
			// changed branch pattern/rules instead of skipping it.
			if err := updateOrgRuleset(client, org, id, rs); err != nil {
				_, _ = fmt.Fprintf(errOut, "Warning: %s: could not update org ruleset %q (%v); review it at https://github.com/organizations/%s/settings/rules — a stale ruleset may %s.\n",
					org, rs.Name, err, org, rulesetMissDescription(rs.Name))
				allReady = false
				continue
			}
			_, _ = fmt.Fprintf(out, "%s: org ruleset %q updated to current definition\n", org, rs.Name)
			continue
		}
		if err := createOrgRuleset(client, org, rs); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: could not create org ruleset %q (%v); apply it manually at https://github.com/organizations/%s/settings/rules — without it students could %s.\n",
				org, rs.Name, err, org, rulesetMissDescription(rs.Name))
			allReady = false
			continue
		}
		_, _ = fmt.Fprintf(out, "%s: org ruleset %q created\n", org, rs.Name)
	}
	return allReady, nil
}

// listOrgRulesets returns existing org rulesets as a name->ID map so
// ensureClassroomRulesets can choose POST (new) vs PUT-by-ID (reconcile).
// Paginated so a large org doesn't hide the Classroom 50 entries (which would
// make the reconcile re-POST and 422).
func listOrgRulesets(client githubapi.Client, org string) (map[string]int64, error) {
	type orgRuleset struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	rulesets, err := githubapi.PaginateAll[orgRuleset](client, 100, 100,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/rulesets?per_page=100&page=%d", url.PathEscape(org), page)
		}, nil)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]int64, len(rulesets))
	for _, r := range rulesets {
		ids[r.Name] = r.ID
	}
	return ids, nil
}

// createOrgRuleset POSTs a single ruleset.
func createOrgRuleset(client githubapi.Client, org string, body orgRulesetBody) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode ruleset %q: %w", body.Name, err)
	}
	path := fmt.Sprintf("orgs/%s/rulesets", url.PathEscape(org))
	if err := client.Post(path, bytes.NewReader(payload), nil); err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	return nil
}

// updateOrgRuleset PUTs the full definition over an existing ruleset by ID, so
// a re-run reconciles a stale ruleset (e.g. an older CLI's wrong branch
// pattern) to the current definition.
func updateOrgRuleset(client githubapi.Client, org string, id int64, body orgRulesetBody) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode ruleset %q: %w", body.Name, err)
	}
	path := fmt.Sprintf("orgs/%s/rulesets/%d", url.PathEscape(org), id)
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PUT %s: unexpected status %d", path, resp.StatusCode)
	}
	return nil
}

// rulesetMissDescription explains, per ruleset, what a teacher loses if it
// couldn't be created — surfaced in the warning so the fix hint is actionable.
func rulesetMissDescription(name string) string {
	switch name {
	case rulesetNameSubmissionHistory:
		return "force-push or delete their submission history on main"
	case rulesetNameFeedbackBase:
		return "merge or move the feedback PR themselves"
	default:
		return "bypass intended branch protections"
	}
}

// setWorkflowPermissions raises the default GITHUB_TOKEN to write. Skeleton
// workflows declare their own permissions; this catches any teacher-added
// workflow that doesn't. (GitHub's new-repo default flipped to read-only in
// 2023.) 409 → org enforces a unified policy; reportOrgWorkflowPermissions
// logs the effective setting and continues.
func setWorkflowPermissions(client githubapi.Client, out io.Writer, owner, repo string) error {
	body, err := json.Marshal(struct {
		DefaultWorkflowPermissions   string `json:"default_workflow_permissions"`
		CanApprovePullRequestReviews bool   `json:"can_approve_pull_request_reviews"`
	}{
		DefaultWorkflowPermissions:   "write",
		CanApprovePullRequestReviews: false,
	})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/actions/permissions/workflow",
		url.PathEscape(owner), url.PathEscape(repo))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusConflict) {
			return reportOrgWorkflowPermissions(client, out, owner, repo)
		}
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("PUT %s: unexpected status %d", path, resp.StatusCode)
	}
	_, _ = fmt.Fprintf(out, "%s/%s: workflow permissions set to write\n", owner, repo)
	return nil
}

// reportOrgWorkflowPermissions logs the effective setting (the org value under
// enforced policy). Always returns nil — a `read` default doesn't break
// bootstrap because skeleton workflows declare their own permissions.
func reportOrgWorkflowPermissions(client githubapi.Client, out io.Writer, owner, repo string) error {
	path := fmt.Sprintf("repos/%s/%s/actions/permissions/workflow",
		url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		DefaultWorkflowPermissions string `json:"default_workflow_permissions"`
	}
	if err := client.Get(path, &resp); err != nil {
		_, _ = fmt.Fprintf(out, "%s/%s: workflow permissions are managed by an org policy (HTTP 409 on PUT); skeleton workflows grant workflow-level permissions, so this is OK.\n", owner, repo)
		return nil
	}
	if resp.DefaultWorkflowPermissions == "write" {
		_, _ = fmt.Fprintf(out, "%s/%s: workflow permissions already write (set at org level)\n", owner, repo)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: org default workflow permissions are %q; skeleton workflows grant workflow-level write where needed. To raise the org default: gh api -X PUT /orgs/%s/actions/permissions/workflow -F default_workflow_permissions=write\n",
		owner, repo, resp.DefaultWorkflowPermissions, owner)
	return nil
}

// enableReusableWorkflowAccess opens this private repo's workflows to other
// repos in the org. The per-classroom autograder shim in every student repo
// references the `autograde-runner.yaml` reusable workflow via `uses:
// <org>/classroom50/...@main`; without this toggle the student repo's token
// gets a 403 resolving that `uses:` line.
//
// PUT .../actions/permissions/access with `access_level: organization` is the
// per-repo lever; idempotent. 403/409 (org-enforced) → warn to errOut, since
// some orgs lock this at the enterprise layer.
func enableReusableWorkflowAccess(client githubapi.Client, out, errOut io.Writer, owner, repo string) error {
	body, err := json.Marshal(struct {
		AccessLevel string `json:"access_level"`
	}{AccessLevel: "organization"})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s/actions/permissions/access",
		url.PathEscape(owner), url.PathEscape(repo))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) || cliutil.IsHTTPStatus(err, http.StatusConflict) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: couldn't enable reusable-workflow access for the org (%v); student-repo autograde workflows may 403 on `uses:`. Retry with an org-admin token: gh api -X PUT /repos/%s/%s/actions/permissions/access -f access_level=organization — or toggle manually at https://github.com/%s/%s/settings/actions → Access if students see workflow-resolution errors.\n",
				owner, repo, err, owner, repo, owner, repo)
			return nil
		}
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: PUT /actions/permissions/access returned HTTP %d while enabling reusable-workflow access; retry with an org-admin token: gh api -X PUT /repos/%s/%s/actions/permissions/access -f access_level=organization — or toggle manually at https://github.com/%s/%s/settings/actions → Access if students see `uses:` errors.\n",
			owner, repo, resp.StatusCode, owner, repo, owner, repo)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: reusable-workflow access enabled (organization)\n", owner, repo)
	return nil
}
