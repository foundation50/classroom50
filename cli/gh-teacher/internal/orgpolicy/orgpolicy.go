// Package orgpolicy is the shared org-member-defaults policy seam: the
// canonical least-privilege member-privilege model, plan-aware filtering of
// which settings apply, classification of a live GET /orgs/{org} response, and
// the manual-hardening checklist for web-UI-only settings with no REST field.
// Both `init` (apply + verify) and `audit` (read-only report) consume it so
// the two can't drift. Depends only on stdlib — the org READ/WRITE stays with
// the callers.
package orgpolicy

import "fmt"

// MemberDefaultSetting is one org-level member policy, kept per-field so the
// 403/422 fallback can retry and warn about each independently. Fields are
// exported because both callers read them off the verdicts this package emits.
type MemberDefaultSetting struct {
	Field string // JSON field on PATCH /orgs/{org}
	Value any    // desired value
	Desc  string // human description for success/warning lines
	// ManualFix: a UI state the teacher can actually reach (plans gate the
	// member-privileges page and some checkbox combos don't exist everywhere).
	ManualFix string
	// Critical marks lockdown fields whose absence re-opens the org-wide
	// repo-admin danger that makes the founder-admin grant in `student accept`
	// safe. If any is rejected, the "repo-admin is defanged org-wide"
	// invariant does NOT hold and init must say so loudly. The enabling fields
	// (private-repo / Pages creation) are non-critical.
	Critical bool
	// enterpriseOnly marks settings whose toggle only exists on GitHub
	// Enterprise Cloud. On Team/Free (the primary audience) the API silently
	// ignores the PATCH and the settings page has no control, so init skips
	// them entirely there (neither attempts, verifies, nor lists them). Kept
	// in the canonical list so Enterprise-Cloud orgs still get them:
	//   - members_can_create_internal_repositories (internal is Enterprise).
	//   - members_can_view_dependency_insights (no Team control).
	//   - members_can_invite_outside_collaborators (Team: owners only).
	//   - members_can_create_public_repositories=false ("private only"): on
	//     Team/Free GitHub couples public+private into one "all or none"
	//     choice, and the student flow REQUIRES private creation, so forcing
	//     public off is impossible there. Enterprise-Cloud-only.
	enterpriseOnly bool
}

// MemberDefaultSettings returns the member policies to apply for the given
// plan, dropping enterprise-only settings on non-enterprise plans. Pass the
// plan slug from preflight; an empty/unknown plan is treated as non-enterprise
// (conservative — only include Enterprise-only fields when sure).
func MemberDefaultSettings(plan string) []MemberDefaultSetting {
	all := allMemberDefaultSettings()
	if plan == "enterprise" {
		return all
	}
	filtered := make([]MemberDefaultSetting, 0, len(all))
	for _, s := range all {
		if s.enterpriseOnly {
			continue
		}
		filtered = append(filtered, s)
	}
	return filtered
}

// allMemberDefaultSettings: the full canonical list, in apply order. Intent: a
// least-privilege org where the only member capability is private-repo
// creation; every other privilege and dangerous repo-admin power is locked to
// owners. Because `student accept` keeps the founder as repo `admin`, these
// org-level locks are what defang that admin org-wide. MemberDefaultSettings
// filters this by plan.
//
// Notable entries:
//   - default_repository_permission "none": no implicit read on other repos.
//   - members_can_create_repositories true: master switch. On Team/Free the
//     granular public/private booleans are slaved to it (true → both on), so
//     it must be true for the student flow; sending only the private boolean
//     leaves BOTH off.
//   - members_can_create_private_repositories true: the one allowed capability.
//   - members_can_create_public_repositories false (enterprise-only): see the
//     enterpriseOnly note above.
//   - members_can_create_pages / _public_pages true: ENFORCED so the config
//     repo can publish its public Pages site (the unauthenticated
//     assignments.json fetch). init resets a tightened setting on re-run.
//   - everything else false: locks the privilege / repo-admin power to owners.
//
// The four web-UI-only privileges with no REST field are handled by
// ManualHardeningSteps, not here.
func allMemberDefaultSettings() []MemberDefaultSetting {
	return []MemberDefaultSetting{
		{
			Field:     "default_repository_permission",
			Value:     "none",
			Desc:      `base repository permission "none"`,
			ManualFix: `set "Base permissions" to "No permission"`,
			Critical:  true,
		},
		{
			// Master repo-creation switch. On Team/Free the granular
			// public/private booleans are slaved to this (true → both, false →
			// none), so the student flow needs it true; sending only the
			// private boolean leaves BOTH off. On Enterprise Cloud the
			// public-repo lockdown below narrows this to private-only.
			Field:     "members_can_create_repositories",
			Value:     true,
			Desc:      "member repo creation enabled",
			ManualFix: `under "Repository creation", allow members to create repositories`,
			Critical:  true,
		},
		{
			Field:     "members_can_create_private_repositories",
			Value:     true,
			Desc:      "private repo creation enabled",
			ManualFix: `under "Repository creation", check "Private" — without it, gh student accept can't create student repos`,
		},
		{
			Field:          "members_can_create_public_repositories",
			Value:          false,
			Desc:           "public repo creation disabled",
			ManualFix:      `under "Repository creation", restrict members to private repositories only (GitHub Enterprise Cloud only)`,
			Critical:       true,
			enterpriseOnly: true,
		},
		{
			Field:          "members_can_create_internal_repositories",
			Value:          false,
			Desc:           "internal repo creation disabled",
			ManualFix:      `under "Repository creation", uncheck "Internal" if your plan offers it`,
			Critical:       true,
			enterpriseOnly: true,
		},
		{
			// Enforced TRUE: the config repo publishes a public Pages site
			// (the unauthenticated assignments.json fetch). init resets this
			// on re-run so a teacher can't accidentally break the student flow.
			Field:     "members_can_create_pages",
			Value:     true,
			Desc:      "Pages creation enabled (required for the public config-repo site)",
			ManualFix: `check "Allow members to publish Pages sites"`,
		},
		{
			// Enforced TRUE for the same reason: the site must publish
			// *publicly*. On non-Enterprise plans this per-visibility control
			// doesn't exist and the field is rejected (the fallback warns).
			Field:     "members_can_create_public_pages",
			Value:     true,
			Desc:      "public Pages creation enabled (required for the public config-repo site)",
			ManualFix: `under "Pages creation", select "Public"`,
		},
		{
			// Private Pages are never needed; keep this one locked.
			Field:     "members_can_create_private_pages",
			Value:     false,
			Desc:      "private Pages creation disabled",
			ManualFix: `under "Pages creation", deselect "Private"`,
			Critical:  true,
		},
		{
			Field:     "members_can_delete_repositories",
			Value:     false,
			Desc:      "member repo deletion/transfer disabled",
			ManualFix: `uncheck "Allow members to delete or transfer repositories for this organization"`,
			Critical:  true,
		},
		{
			Field:     "members_can_change_repo_visibility",
			Value:     false,
			Desc:      "member repo visibility change disabled",
			ManualFix: `uncheck "Allow members to change repository visibilities for this organization"`,
			Critical:  true,
		},
		{
			Field:     "members_can_delete_issues",
			Value:     false,
			Desc:      "member issue deletion disabled",
			ManualFix: `uncheck "Allow members to delete issues for this organization"`,
			Critical:  true,
		},
		{
			Field:     "readers_can_create_discussions",
			Value:     false,
			Desc:      "discussion creation by read-access members disabled",
			ManualFix: `uncheck "Allow users with read access to create discussions"`,
			Critical:  true,
		},
		{
			Field:     "members_can_create_teams",
			Value:     false,
			Desc:      "member team creation disabled",
			ManualFix: `uncheck "Allow members to create teams"`,
			Critical:  true,
		},
		{
			Field:          "members_can_view_dependency_insights",
			Value:          false,
			Desc:           "member dependency-insights viewing disabled",
			ManualFix:      `uncheck "Allow members to view dependency insights"`,
			Critical:       true,
			enterpriseOnly: true,
		},
		{
			Field:          "members_can_invite_outside_collaborators",
			Value:          false,
			Desc:           "member-invited outside collaborators disabled",
			ManualFix:      `uncheck "Allow members to invite outside collaborators to repositories for this organization"`,
			Critical:       true,
			enterpriseOnly: true,
		},
	}
}

// DefaultVerdict is one setting's live-classification result from
// ClassifyDefaults: the source Setting plus whether the live value matched the
// desired lockdown value. Both init's read-back and audit's report derive from
// this single classification so the compare logic lives in one place.
type DefaultVerdict struct {
	Setting  MemberDefaultSetting
	Enforced bool
}

// ClassifyDefaults compares each in-scope (plan-filtered) setting against the
// live org values and reports per-setting enforcement plus whether any critical
// setting is unenforced. The single source of truth for interpreting a GET
// /orgs/{org} response, shared by init and audit.
func ClassifyDefaults(live map[string]any, plan string) (verdicts []DefaultVerdict, criticalMissed bool) {
	settings := MemberDefaultSettings(plan)
	verdicts = make([]DefaultVerdict, 0, len(settings))
	for _, s := range settings {
		enforced := fieldMatches(live[s.Field], s.Value)
		verdicts = append(verdicts, DefaultVerdict{Setting: s, Enforced: enforced})
		if !enforced && s.Critical {
			criticalMissed = true
		}
	}
	return verdicts, criticalMissed
}

// fieldMatches compares a desired lockdown value against GitHub's returned
// value. JSON decodes booleans as bool and strings as string, so a direct
// compare works for both the bool toggles and the one string field.
func fieldMatches(live, desired any) bool {
	return live == desired
}

// ManualStep is one API-less org setting the teacher must apply by hand.
// JSON tags carry no omitempty so it serializes stably in init's and audit's
// --json reports.
type ManualStep struct {
	Setting string `json:"setting"`
	URL     string `json:"url"`
}

// RecommendedOrgDefaultBranch is the org "Repository default branch name" we
// recommend. GitHub exposes no REST field to set it (PATCH /orgs ignores
// default_repository_branch — it's web-UI-only), so this is surfaced as an
// advisory recommendation, never an enforced/critical setting.
const RecommendedOrgDefaultBranch = "main"

// OrgDefaultBranchRecommendation returns the org's current default branch name
// when it differs from RecommendedOrgDefaultBranch (so callers can advise a
// hand-fix), or "" when it already matches / is unset / unreadable. `live` is
// the raw GET /orgs/{org} map.
func OrgDefaultBranchRecommendation(live map[string]any) string {
	branch, ok := live["default_repository_branch"].(string)
	if !ok || branch == "" || branch == RecommendedOrgDefaultBranch {
		return ""
	}
	return branch
}

// ConfigRepoDefaultBranchRecommendation returns the config repo's current
// default branch when it differs from RecommendedOrgDefaultBranch (so callers
// can advise renaming it), or "" when it already matches / is unset / couldn't
// be read. Unlike the org-default recommendation this branch IS API-renameable,
// but the CLI audit is read-only, so both surface it identically as advice.
func ConfigRepoDefaultBranchRecommendation(branch string) string {
	if branch == "" || branch == RecommendedOrgDefaultBranch {
		return ""
	}
	return branch
}

// ConfigRepoBranchesURL is the config repo's branches settings page where a
// teacher can rename the default branch to `main`.
func ConfigRepoBranchesURL(org string) string {
	return fmt.Sprintf("https://github.com/%s/classroom50/settings/branches", org)
}

// OrgRepositoryDefaultsURL is the org settings page where the default branch
// name is changed (the one setting with no REST write path).
func OrgRepositoryDefaultsURL(org string) string {
	return fmt.Sprintf("https://github.com/organizations/%s/settings/repository-defaults", org)
}

// ManualHardeningSteps is the canonical list of the four member-privilege
// settings with no REST API (single-sourced so init's reminder, init's JSON,
// and audit's list can't drift). Each instruction is verb-first with the
// section name in parentheses for orientation.
func ManualHardeningSteps(org string) []ManualStep {
	url := fmt.Sprintf("https://github.com/organizations/%s/settings/member_privileges", org)
	return []ManualStep{
		{Setting: `Set "App access requests" to "Members only" (or "Disable app access requests")`, URL: url},
		{Setting: `Uncheck "Allow repository admins to install GitHub Apps for their repositories" (under "GitHub Apps")`, URL: url},
		{Setting: `Set "Projects base permissions" to "No access"`, URL: url},
		{Setting: `Uncheck "Allow repository administrators to rename branches protected by organization rules" (under "Branch renames")`, URL: url},
	}
}
