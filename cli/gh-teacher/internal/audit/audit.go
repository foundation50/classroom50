// Package audit implements the `gh teacher audit` command: a read-only audit
// of an org's member-privilege lockdown. It re-reads the org and reports, per
// setting, whether the least-privilege value `init` applies is in effect. Only
// NewCmd is exported.
package audit

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/orgpolicy"
	"github.com/foundation50/gh-teacher/internal/ui"
)

// NewCmd implements `gh teacher audit <org>`: a read-only audit of the org
// member-privilege lockdown, using the same authoritative read-back as init so
// a teacher can confirm a manual fix landed without re-running the mutating
// init.
//
// Two setting classes are reported separately:
//   - API-readable lockdown fields: audit reads the live value and flags any
//     mismatch.
//   - The four web-UI-only hardening settings: GitHub has no REST field, so
//     audit lists them as "confirm by hand" rather than pretending they're OK.
//
// Exit is non-zero when ANY API-readable field is unenforced (scriptable,
// agreeing with the web GUI's verdict). The unreadable manual items never fail
// the command.
func NewCmd() *cobra.Command {
	var asJSON bool

	cmd := &cobra.Command{
		Use:   "audit <org>",
		Short: "Audit the org member-privilege lockdown (read-only)",
		Long: "Re-read an organization and report whether the least-privilege\n" +
			"member-privilege lockdown that `gh teacher init` applies is\n" +
			"actually in effect. Read-only: makes no changes.\n\n" +
			"Use it to confirm a manual fix took hold — e.g. after you\n" +
			"unchecked the boxes from init's \"Action required\" list — without\n" +
			"re-running init.\n\n" +
			"Reports two groups:\n" +
			"  - API-readable settings: audit reads each live value and flags\n" +
			"    any that still don't match the locked-down value.\n" +
			"  - The four web-UI-only settings (app access requests, repo-admin\n" +
			"    GitHub App installs, Projects base permissions, branch renames):\n" +
			"    GitHub exposes no REST API to read these, so audit can't\n" +
			"    confirm them — it lists them for you to eyeball by hand.\n\n" +
			"Exit status is non-zero when ANY API-readable lockdown field\n" +
			"is unenforced (scriptable); the unreadable manual items\n" +
			"never fail the command.\n\n" +
			"Flags: --json (machine-readable report on stdout).",
		Example: "  gh teacher audit cs50-fall-2026\n" +
			"  gh teacher audit cs50-fall-2026 --json",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			if org == "" {
				return errors.New("org must not be empty")
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			// Plan drives which fields are in scope (Team/Free don't expose the
			// enterprise-only toggles). A failed lookup is non-fatal: it
			// yields an empty plan (non-enterprise scope), and the org read in
			// buildAuditReport sets ReadOK / the exit status.
			plan, _ := githubapi.OrgPlan(client, org)

			report := buildAuditReport(client, org, plan)

			// Render, then apply the SAME scriptable exit status on both paths
			// (non-zero when any API-readable field is unenforced, or the org
			// couldn't be read) so `audit --json && deploy` can't proceed on an
			// incomplete lockdown.
			if asJSON {
				if err := report.renderJSON(cmd.OutOrStdout()); err != nil {
					return err
				}
			} else {
				report.renderHuman(ui.New(cmd.ErrOrStderr()))
			}
			if !report.LockdownComplete {
				return errors.New("org member-privilege lockdown INCOMPLETE — see the report above")
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit a machine-readable JSON report on stdout")
	return cmd
}

// auditReport is the canonical record behind both renderers, mirroring
// initSummary's single-source-of-truth pattern so the two surfaces can't drift.
type auditReport struct {
	Org  string `json:"org"`
	Plan string `json:"plan"`
	// ReadOK is false when the org couldn't be read (network/permission); then
	// Enforced is empty and the audit is inconclusive.
	ReadOK bool `json:"read_ok"`
	// LockdownComplete is true when NO API-readable field is unenforced (any
	// drift fails), matching the web GUI's verdict. Manual items don't affect it.
	LockdownComplete bool `json:"lockdown_complete"`
	// Enforced/Unenforced: API-readable lockdown settings whose live value
	// matches / doesn't match (the latter each with a UI fix instruction).
	Enforced   []auditSetting `json:"enforced"`
	Unenforced []auditSetting `json:"unenforced"`
	// ManualUnreadable: web-UI-only settings with no REST field; audit can't
	// confirm them and asks the teacher to eyeball them.
	ManualUnreadable []orgpolicy.ManualStep `json:"manual_unreadable"`
	// BudgetCap is the org's $0 Actions spending-cap verdict. A "missing" tier
	// (or an alert-only cap that doesn't stop spend) is critical drift and
	// gates LockdownComplete; a "warn" tier (a teacher cap over the warn
	// threshold) is advisory and never gates.
	BudgetCap budgetCapResult `json:"budget_cap"`
	// DefaultBranchRec: advisory-only. When set, the org's default repository
	// branch name (this value) isn't `main`; recommended, never a failure.
	DefaultBranchRec string `json:"default_branch_recommendation,omitempty"`
	// RepositoryDefaultsURL is the settings page for the default-branch fix.
	RepositoryDefaultsURL string `json:"repository_defaults_url,omitempty"`
	// ConfigRepoBranchRec: advisory-only. When set, the classroom50 config
	// repo's default branch (this value) isn't `main`; recommended, never a
	// failure. Renameable in the web app; hand-fix link here.
	ConfigRepoBranchRec string `json:"config_repo_branch_recommendation,omitempty"`
	// ConfigRepoBranchesURL is the config repo's branches settings page.
	ConfigRepoBranchesURL string `json:"config_repo_branches_url,omitempty"`
	// SettingsURL is the org member-privileges page every item lives on.
	SettingsURL string `json:"settings_url"`
}

// auditSetting is one API-readable lockdown field's audit result.
type auditSetting struct {
	Field    string `json:"field"`
	Desc     string `json:"desc"`
	Critical bool   `json:"critical"`
	// Fix is the GitHub-UI instruction to apply the locked-down value;
	// only meaningful for unenforced settings.
	Fix string `json:"fix,omitempty"`
}

// budgetCapResult is the org Actions budget-cap audit outcome.
type budgetCapResult struct {
	// ReadOK is false when the budgets list couldn't be read (no billing
	// visibility / token lacks Organization Administration: Read). Then the
	// verdict is inconclusive and advisory, never a critical gate.
	ReadOK bool `json:"read_ok"`
	// Tier is the orgpolicy.BudgetTier string ("missing"/"enforced"/"ok"/
	// "warn"), empty when ReadOK is false.
	Tier string `json:"tier"`
	// Amount is the matched budget's dollar amount (0 when missing).
	Amount int `json:"amount"`
	// SettingsURL is the org billing-budgets page for the hand-fix.
	SettingsURL string `json:"settings_url"`
}

// isCritical reports whether the budget cap is drift that should fail the
// audit: a successful read showing the guardrail is absent (missing tier,
// which also covers an alert-only cap that doesn't stop spend). An unreadable
// verdict is advisory, not critical.
func (b budgetCapResult) isCritical() bool {
	return b.ReadOK && b.Tier == string(orgpolicy.BudgetMissing)
}

// isWarn reports whether the budget cap is a non-gating warning: a teacher-set
// cap over the warn threshold.
func (b budgetCapResult) isWarn() bool {
	return b.ReadOK && b.Tier == string(orgpolicy.BudgetWarn)
}

// buildAuditReport reads the org back and classifies every in-scope setting as
// enforced/unenforced, plus the always-unreadable manual items. A read failure
// yields ReadOK=false with LockdownComplete=false (conservatively a failure).
func buildAuditReport(client githubapi.Client, org, plan string) auditReport {
	settingsURL := fmt.Sprintf("https://github.com/organizations/%s/settings/member_privileges", org)
	report := auditReport{
		Org:              org,
		Plan:             plan,
		Enforced:         []auditSetting{},
		Unenforced:       []auditSetting{},
		ManualUnreadable: orgpolicy.ManualHardeningSteps(org),
		SettingsURL:      settingsURL,
		BudgetCap:        budgetCapResult{SettingsURL: orgpolicy.OrgBudgetsURL(org)},
	}

	live, err := readOrgMemberSettings(client, org)
	if err != nil {
		report.ReadOK = false
		report.LockdownComplete = false
		return report
	}
	report.ReadOK = true

	verdicts, _ := orgpolicy.ClassifyDefaults(live, plan)
	for _, v := range verdicts {
		as := auditSetting{Field: v.Setting.Field, Desc: v.Setting.Desc, Critical: v.Setting.Critical}
		if v.Enforced {
			report.Enforced = append(report.Enforced, as)
			continue
		}
		as.Fix = v.Setting.ManualFix
		report.Unenforced = append(report.Unenforced, as)
	}
	// Any drift fails (match the web GUI). The per-setting Critical flag is
	// still surfaced for ordering/labeling but no longer gates the verdict.
	report.LockdownComplete = len(report.Unenforced) == 0

	// Actions budget cap: a successful read showing the guardrail is absent is
	// critical drift that gates the verdict; a read failure is advisory (no
	// billing visibility), and a >threshold cap is a non-gating warning.
	report.BudgetCap = classifyBudgetCap(client, org)
	if report.BudgetCap.isCritical() {
		report.LockdownComplete = false
	}

	// Advisory-only: the org default branch name isn't `main`. Never gates the
	// verdict (GitHub has no API to set it — only a hand-fix reminder).
	if rec := orgpolicy.OrgDefaultBranchRecommendation(live); rec != "" {
		report.DefaultBranchRec = rec
		report.RepositoryDefaultsURL = orgpolicy.OrgRepositoryDefaultsURL(org)
	}

	// Advisory-only: the classroom50 config repo drifted off `main`. Renameable
	// in the web app; here we only recommend + link. A read failure (e.g. repo
	// not yet initialized) simply omits the recommendation — it never gates the
	// verdict.
	if branch, err := configrepo.ResolveConfigRepoBranch(client, org); err == nil {
		if rec := orgpolicy.ConfigRepoDefaultBranchRecommendation(branch); rec != "" {
			report.ConfigRepoBranchRec = rec
			report.ConfigRepoBranchesURL = orgpolicy.ConfigRepoBranchesURL(org)
		}
	}
	return report
}

// readOrgMemberSettings GETs the org and returns the raw field map. Separated
// from init's verifyOrgDefaults (which also emits warnings) so audit reads
// clean.
func readOrgMemberSettings(client githubapi.Client, org string) (map[string]any, error) {
	path := fmt.Sprintf("orgs/%s", url.PathEscape(org))
	var live map[string]any
	if err := client.Get(path, &live); err != nil {
		return nil, err
	}
	return live, nil
}

// classifyBudgetCap reads the org's billing budgets and classifies the Actions
// cap. A read failure yields ReadOK=false (advisory, inconclusive) rather than
// a false critical — mirroring how the member-default read-back degrades.
func classifyBudgetCap(client githubapi.Client, org string) budgetCapResult {
	res := budgetCapResult{SettingsURL: orgpolicy.OrgBudgetsURL(org)}
	budgets, err := githubapi.ListOrgBudgets(client, org)
	if err != nil {
		return res // ReadOK stays false.
	}
	v := orgpolicy.ClassifyBudget(budgets)
	res.ReadOK = true
	res.Tier = string(v.Tier)
	res.Amount = v.Amount
	return res
}

// renderJSON writes the report as one indented JSON object. HTML escaping is
// off so `>` in fix instructions stays readable.
func (r *auditReport) renderJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

// renderHuman writes the audit to stderr: an outcome banner, enforced settings
// (collapsed to ✓ lines), an "Action required" checklist for unenforced
// API-readable settings, and a separate "Confirm by hand" list for the
// web-UI-only settings audit can't read.
func (r *auditReport) renderHuman(u *ui.UI) {
	u.Blank()

	if !r.ReadOK {
		u.Result(ui.StatusFail, "%s: couldn't read the org to audit the lockdown", r.Org)
		u.Detail("Check your network and that your token can read %s, then retry.", r.SettingsURL)
		return
	}

	if r.LockdownComplete {
		u.Result(ui.StatusOK, "%s: member-privilege lockdown verified", r.Org)
	} else {
		u.Result(ui.StatusFail, "%s: member-privilege lockdown INCOMPLETE", r.Org)
	}

	if len(r.Enforced) > 0 {
		u.Heading("Verified (read from the API)")
		for _, s := range r.Enforced {
			u.OkItem("%s", s.Desc)
		}
		if r.BudgetCap.ReadOK && (r.BudgetCap.Tier == string(orgpolicy.BudgetEnforced) || r.BudgetCap.Tier == string(orgpolicy.BudgetOK)) {
			u.OkItem("Actions spending cap in place ($%d)", r.BudgetCap.Amount)
		}
	}

	if len(r.Unenforced) > 0 || r.BudgetCap.isCritical() {
		u.Heading("Action required — these are NOT locked down")
		for _, s := range r.Unenforced {
			label := s.Fix
			if label == "" {
				label = s.Desc
			}
			if s.Critical {
				u.Checkbox("%s", label)
			} else {
				u.Checkbox("(non-critical) %s", label)
			}
		}
		if r.BudgetCap.isCritical() {
			u.Checkbox("set a $0 GitHub Actions budget (hard-stop) to block paid Actions minutes")
			u.Detail("at %s", r.BudgetCap.SettingsURL)
		}
		if len(r.Unenforced) > 0 {
			u.Detail("at %s", r.SettingsURL)
		}
	}

	// The four web-UI-only settings can't be read back. Present them as an
	// instruction list (not checkboxes, which would imply the CLI tracks their
	// state): lead with "open and confirm", then the numbered items.
	if len(r.ManualUnreadable) > 0 {
		u.Heading("Confirm by hand (GitHub exposes no API to read these)")
		u.Detail("Open %s and confirm each setting below:", r.ManualUnreadable[0].URL)
		for i, m := range r.ManualUnreadable {
			u.Numbered(i+1, "%s", m.Setting)
		}
	}

	// Advisory recommendation — highly recommended, never a failure.
	if r.DefaultBranchRec != "" || r.ConfigRepoBranchRec != "" || r.BudgetCap.isWarn() || !r.BudgetCap.ReadOK {
		u.Heading("Recommended (not required)")
	}
	if r.BudgetCap.isWarn() {
		u.Detail("Your org has a GitHub Actions budget over $%d ($%d). Classroom 50 recommends a $0 hard-stop cap so a runaway autograde workflow can't run up a bill; lower it at %s.",
			orgpolicy.BudgetWarnThreshold, r.BudgetCap.Amount, r.BudgetCap.SettingsURL)
	}
	if !r.BudgetCap.ReadOK {
		u.Detail("Couldn't verify the org's Actions spending cap (your token likely lacks Organization Administration: Read, or the plan doesn't expose budgets). Confirm a $0 GitHub Actions budget is set at %s.",
			r.BudgetCap.SettingsURL)
	}
	if r.DefaultBranchRec != "" {
		u.Detail("Your org's default branch name for new repositories is %q; we recommend %q so new repos (including student assignment repos) match Classroom 50's convention. Existing repos are unaffected.",
			r.DefaultBranchRec, orgpolicy.RecommendedOrgDefaultBranch)
		u.Detail("Change it at %s", r.RepositoryDefaultsURL)
	}
	if r.ConfigRepoBranchRec != "" {
		u.Detail("The classroom50 config repo's default branch is %q, not %q; everything still works (reads/writes target the real branch), but renaming it matches Classroom 50's convention. The web app can rename it for you.",
			r.ConfigRepoBranchRec, orgpolicy.RecommendedOrgDefaultBranch)
		u.Detail("Rename it at %s", r.ConfigRepoBranchesURL)
	}
}
