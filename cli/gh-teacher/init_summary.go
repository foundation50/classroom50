package main

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/foundation50/gh-teacher/internal/orgpolicy"
	"github.com/foundation50/gh-teacher/internal/ui"
)

// initSummary is the canonical record of what `gh teacher init` did, the single
// source of truth behind all three renderers (human box, plain, --json) so they
// can't drift. JSON tags follow the repo convention: no omitempty, slices
// always initialized (serialize as [] not null).
type initSummary struct {
	Org    string `json:"org"`
	DryRun bool   `json:"dry_run"`
	// Ready is the overall go/no-go: no preflight failure, lockdown invariant
	// holds, no fatal step. Feedback-PR readiness is reported separately.
	Ready            bool        `json:"ready"`
	Plan             string      `json:"plan"`
	ConfigRepo       repoSummary `json:"config_repo"`
	PagesURL         string      `json:"pages_url"`
	LockdownComplete bool        `json:"lockdown_complete"`
	// LockdownManualSteps lists the settings init couldn't apply via the API,
	// each with its GitHub-UI instruction. Derived from the read-back.
	LockdownManualSteps []orgpolicy.ManualStep `json:"lockdown_manual_steps"`
	FeedbackPRReady     bool                   `json:"feedback_pr_ready"`
	// BudgetCap describes the reconciliation outcome for the org's $0 Actions
	// spending cap: "created" (init made it), "present" (already conforming),
	// "warn" (teacher set a cap over the warn threshold — left untouched),
	// "unreadable" (couldn't read budgets), "failed" (create write denied), or
	// "" (not attempted, e.g. dry run). Informational; it never gates Ready.
	BudgetCap string `json:"budget_cap"`
	// ServiceToken describes how the token ended up configured this run, so a
	// re-run is self-explanatory.
	ServiceToken string `json:"service_token"`
	// ManualHardeningRequired: org settings with no REST API. Surfaced as
	// structured data so an agent can branch on "manual steps pending".
	ManualHardeningRequired []orgpolicy.ManualStep `json:"manual_hardening_required"`
	// Notes are plan/policy caveats that are NOT action items — e.g. on
	// Team/Free, public-repo creation can't be locked off, so "lockdown
	// complete" doesn't mean public creation is disabled.
	Notes     []string         `json:"notes"`
	Preflight []preflightCheck `json:"preflight"`
	Warnings  []string         `json:"warnings"`
}

type repoSummary struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Created bool   `json:"created"`
}

// newInitSummary returns a summary with all slices initialized (JSON emits []
// not null) and the manual-hardening checklist pre-populated.
func newInitSummary(org string) *initSummary {
	return &initSummary{
		Org:                     org,
		LockdownManualSteps:     []orgpolicy.ManualStep{},
		ManualHardeningRequired: orgpolicy.ManualHardeningSteps(org),
		Notes:                   []string{},
		Preflight:               []preflightCheck{},
		Warnings:                []string{},
	}
}

// addWarning records a warning in the summary. It powers the JSON `warnings`
// array and the human warning count.
func (s *initSummary) addWarning(format string, a ...any) {
	s.Warnings = append(s.Warnings, fmt.Sprintf(format, a...))
}

// addNote records an informational, non-action caveat (see Notes). Unlike
// addWarning it doesn't imply something went wrong.
func (s *initSummary) addNote(format string, a ...any) {
	s.Notes = append(s.Notes, fmt.Sprintf(format, a...))
}

// finalize computes Ready: not a dry run, lockdown invariant holds, config repo
// landed. FeedbackPRReady is intentionally NOT part of Ready.
func (s *initSummary) finalize() {
	s.Ready = !s.DryRun && s.LockdownComplete && s.ConfigRepo.URL != ""
}

// renderJSON writes the summary as a single indented JSON object to stdout
// (the only thing on stdout under --json). HTML escaping is off so `>` stays
// readable.
func (s *initSummary) renderJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(s)
}

// renderHuman writes the end-of-run report to stderr: an outcome banner, a
// terse setup summary, one consolidated "action required" checklist, and the
// next command. No box — long URLs would overflow it.
func (s *initSummary) renderHuman(u *ui.UI) {
	// 1. Outcome banner, preceded by a blank line to separate it from the
	// progress output above (we don't hard-clear the terminal).
	u.Blank()
	switch {
	case s.Ready:
		u.Result(preflightOK, "%s: init complete", s.Org)
	case s.LockdownComplete:
		u.Result(preflightWarn, "%s: init finished with warnings", s.Org)
	default:
		u.Result(preflightFail, "%s: init INCOMPLETE — action needed", s.Org)
	}

	// 2. Terse setup summary.
	u.Heading("Setup")
	if s.ConfigRepo.URL != "" {
		verb := "reused"
		if s.ConfigRepo.Created {
			verb = "created"
		}
		u.Item("config repo (%s): %s", verb, s.ConfigRepo.URL)
	}
	if s.PagesURL != "" {
		u.Item("pages (after first publish-pages run): %s", s.PagesURL)
	}
	if s.ServiceToken != "" {
		u.Item("service token: %s", s.ServiceToken)
	}
	if s.FeedbackPRReady {
		u.Item("feedback PR prerequisites: ready")
	} else {
		u.Item("feedback PR prerequisites: incomplete — assignments using --feedback-pr may not open PRs")
	}
	switch s.BudgetCap {
	case "created":
		u.Item("actions budget cap: created a $0 spending cap (blocks paid Actions minutes)")
	case "present":
		u.Item("actions budget cap: in place")
	case "warn":
		u.Item("actions budget cap: a budget over $%d is set — left as-is; lower it to $0 to hard-stop paid Actions minutes", orgpolicy.BudgetWarnThreshold)
	case "unreadable":
		u.Item("actions budget cap: couldn't verify (token lacks Organization Administration: Read); set a $0 Actions budget by hand")
	case "failed":
		u.Item("actions budget cap: couldn't be created (token needs Organization Administration: Read and write); set a $0 Actions budget by hand")
	}

	// 2b. Informational notes (plan/policy caveats that aren't actions).
	if len(s.Notes) > 0 {
		u.Heading("Notes")
		for _, n := range s.Notes {
			u.Item("%s", n)
		}
	}

	// 3. One consolidated manual-action checklist: the lockdown steps init
	// couldn't apply and the always-API-less hardening steps both live on the
	// org member-privileges page, so merge them.
	settingsURL := manualSettingsURL(s)
	manual := s.manualActions()
	if len(manual) > 0 {
		u.Heading("Action required — set these by hand (org owner)")
		// When incomplete, lead with the plan-aware reason.
		if !s.LockdownComplete {
			u.Detail("%s", unenforcedCause(s.Plan))
		}
		for _, m := range manual {
			u.Checkbox("%s", m)
		}
		if settingsURL != "" {
			u.Detail("at %s", settingsURL)
		}
		u.Detail("then run `gh teacher audit %s` to confirm the API-readable settings landed", s.Org)
	}

	// 4. Prominent next step.
	u.Next(fmt.Sprintf("gh teacher classroom add %s <short-name>", s.Org))
}

// manualActions merges the unenforced lockdown steps (present only when the
// lockdown is incomplete) with the always-manual hardening steps into one
// ordered checklist.
func (s *initSummary) manualActions() []string {
	var out []string
	if !s.LockdownComplete {
		for _, m := range s.LockdownManualSteps {
			out = append(out, m.Setting)
		}
	}
	for _, m := range s.ManualHardeningRequired {
		out = append(out, m.Setting)
	}
	return out
}

// manualSettingsURL returns the org member-privileges page URL shared by every
// manual step.
func manualSettingsURL(s *initSummary) string {
	if len(s.LockdownManualSteps) > 0 {
		return s.LockdownManualSteps[0].URL
	}
	if len(s.ManualHardeningRequired) > 0 {
		return s.ManualHardeningRequired[0].URL
	}
	return ""
}
