package audit

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
	"github.com/foundation50/gh-teacher/internal/orgpolicy"
	"github.com/foundation50/gh-teacher/internal/ui"
)

// orgLiveFromSettings builds a live org field map where every in-scope
// member-default reads at its desired (locked-down) value, so a test can
// start from a fully-enforced baseline and then flip individual fields to
// simulate drift.
func orgLiveFromSettings(plan string) map[string]any {
	live := map[string]any{}
	for _, s := range orgpolicy.MemberDefaultSettings(plan) {
		live[s.Field] = s.Value
	}
	return live
}

// isBudgetsPath reports whether the request targets the org billing-budgets
// endpoint, so a test handler can serve budgets separately from the org read.
func isBudgetsPath(r *http.Request) bool {
	return strings.Contains(r.URL.Path, "/settings/billing/budgets")
}

// enforcedActionsBudget is the JSON a happy-path budgets read returns: a single
// $0 hard-stop org Actions budget (the enforced tier), so member-default tests
// aren't derailed by an unrelated budget-cap failure.
func enforcedActionsBudget() map[string]any {
	return map[string]any{
		"budgets": []map[string]any{{
			"budget_scope":          orgpolicy.BudgetScopeOrg,
			"budget_product_sku":    orgpolicy.BudgetProductSKUActions,
			"budget_amount":         0,
			"prevent_further_usage": true,
		}},
	}
}

func TestBuildAuditReport_AllEnforced(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("audit must be read-only; got %s %s", r.Method, r.URL.Path)
		}
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(orgLiveFromSettings("team"))
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if !report.ReadOK {
		t.Fatal("ReadOK = false, want true")
	}
	if !report.LockdownComplete {
		t.Errorf("LockdownComplete = false, want true when every field matches")
	}
	if len(report.Unenforced) != 0 {
		t.Errorf("Unenforced = %+v, want none", report.Unenforced)
	}
	if want := len(orgpolicy.MemberDefaultSettings("team")); len(report.Enforced) != want {
		t.Errorf("Enforced = %d, want %d (all in-scope settings)", len(report.Enforced), want)
	}
	// The four web-UI-only settings are always surfaced as unreadable.
	if len(report.ManualUnreadable) != 4 {
		t.Errorf("ManualUnreadable = %d, want 4 (the API-less hardening steps)", len(report.ManualUnreadable))
	}
	if report.BudgetCap.Tier != string(orgpolicy.BudgetEnforced) {
		t.Errorf("BudgetCap.Tier = %q, want enforced", report.BudgetCap.Tier)
	}
}

func TestBuildAuditReport_RecommendsNonMainDefaultBranch(t *testing.T) {
	live := orgLiveFromSettings("team")
	live["default_repository_branch"] = "master"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	// Advisory only — a non-main default branch never fails the lockdown.
	if !report.LockdownComplete {
		t.Errorf("LockdownComplete = false; a non-main default branch must not fail the audit")
	}
	if report.DefaultBranchRec != "master" {
		t.Errorf("DefaultBranchRec = %q, want %q", report.DefaultBranchRec, "master")
	}
	if !strings.Contains(report.RepositoryDefaultsURL, "/settings/repository-defaults") {
		t.Errorf("RepositoryDefaultsURL = %q, want the repository-defaults settings page", report.RepositoryDefaultsURL)
	}
}

func TestBuildAuditReport_NoRecommendationWhenDefaultBranchIsMain(t *testing.T) {
	live := orgLiveFromSettings("team")
	live["default_repository_branch"] = "main"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")
	if report.DefaultBranchRec != "" {
		t.Errorf("DefaultBranchRec = %q, want empty when already main", report.DefaultBranchRec)
	}
}

func TestBuildAuditReport_RecommendsNonMainConfigRepoBranch(t *testing.T) {
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		if strings.HasPrefix(r.URL.Path, "/repos/") {
			_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "master"})
			return
		}
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	// Advisory only — a non-main config-repo branch never fails the lockdown.
	if !report.LockdownComplete {
		t.Errorf("LockdownComplete = false; a non-main config-repo branch must not fail the audit")
	}
	if report.ConfigRepoBranchRec != "master" {
		t.Errorf("ConfigRepoBranchRec = %q, want %q", report.ConfigRepoBranchRec, "master")
	}
	if !strings.Contains(report.ConfigRepoBranchesURL, "/classroom50/settings/branches") {
		t.Errorf("ConfigRepoBranchesURL = %q, want the config repo branches page", report.ConfigRepoBranchesURL)
	}
}

func TestBuildAuditReport_NoConfigRepoRecommendationWhenUnreadable(t *testing.T) {
	// A config-repo read failure (e.g. repo not initialized) must omit the
	// recommendation without failing the audit — it's advisory.
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		if strings.HasPrefix(r.URL.Path, "/repos/") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")
	if report.ConfigRepoBranchRec != "" {
		t.Errorf("ConfigRepoBranchRec = %q, want empty when the config repo can't be read", report.ConfigRepoBranchRec)
	}
	if !report.LockdownComplete {
		t.Errorf("a config-repo read failure must not fail the lockdown verdict")
	}
}

func TestBuildAuditReport_CriticalDriftFails(t *testing.T) {
	// A teacher who re-checked "delete or transfer repositories" leaves a
	// critical lockdown field un-set: audit must flag it and report the
	// lockdown INCOMPLETE (non-zero exit for scripts).
	const drifted = "members_can_delete_repositories"
	live := orgLiveFromSettings("team")
	live[drifted] = true // re-opened the privilege

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if report.LockdownComplete {
		t.Errorf("a critical field (%s) drifted; LockdownComplete must be false", drifted)
	}
	if len(report.Unenforced) != 1 || report.Unenforced[0].Field != drifted {
		t.Fatalf("Unenforced = %+v, want one entry for %s", report.Unenforced, drifted)
	}
	if report.Unenforced[0].Fix == "" {
		t.Errorf("unenforced setting should carry a fix instruction")
	}
	if !report.Unenforced[0].Critical {
		t.Errorf("%s is a critical lockdown field; Critical should be true", drifted)
	}
}

func TestBuildAuditReport_NonCriticalDriftFails(t *testing.T) {
	// A non-critical field (private repo creation enabled) drifting now
	// FAILS the lockdown invariant — any drift is treated as failing to
	// match the web GUI's verdict. The field is still reported as
	// non-critical, but LockdownComplete goes false.
	const drifted = "members_can_create_private_repositories"
	live := orgLiveFromSettings("team")
	live[drifted] = false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if report.LockdownComplete {
		t.Errorf("a non-critical field drifted; LockdownComplete must be false (any drift fails)")
	}
	found := false
	for _, s := range report.Unenforced {
		if s.Field == drifted {
			found = true
			if s.Critical {
				t.Errorf("%s should be non-critical", drifted)
			}
		}
	}
	if !found {
		t.Errorf("Unenforced should still list the drifted non-critical field %s", drifted)
	}
}

func TestBuildAuditReport_ReadFailureIsInconclusive(t *testing.T) {
	// A read failure must NOT report a clean lockdown: ReadOK=false and
	// LockdownComplete=false so the scriptable exit status is a
	// conservative failure rather than a false all-clear.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Forbidden"}`))
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if report.ReadOK {
		t.Errorf("ReadOK = true on a 403, want false")
	}
	if report.LockdownComplete {
		t.Errorf("LockdownComplete = true on a read failure, want false (inconclusive)")
	}
}

func TestBuildAuditReport_PlanScopesEnterpriseFields(t *testing.T) {
	// On Team, enterprise-only fields are out of scope: even if they read
	// as "wrong", audit must not include or fail on them. Build a Team
	// baseline (which omits them) and confirm the audit ignores them.
	live := orgLiveFromSettings("team")
	// Inject an enterprise-only field at a non-locked value — audit on
	// Team must not flag it.
	live["members_can_view_dependency_insights"] = true

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(enforcedActionsBudget())
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if !report.LockdownComplete {
		t.Errorf("an enterprise-only field is out of scope on Team; lockdown should be complete")
	}
	for _, s := range append(report.Enforced, report.Unenforced...) {
		if s.Field == "members_can_view_dependency_insights" {
			t.Errorf("enterprise-only field must not appear in a Team-plan audit")
		}
	}
}

func TestBuildAuditReport_MissingBudgetIsCritical(t *testing.T) {
	// A successful budgets read showing no Actions cap is critical drift: the
	// guardrail is absent, so the audit must fail.
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"budgets": []map[string]any{}})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if report.LockdownComplete {
		t.Errorf("a missing Actions budget is critical drift; LockdownComplete must be false")
	}
	if report.BudgetCap.Tier != string(orgpolicy.BudgetMissing) {
		t.Errorf("BudgetCap.Tier = %q, want missing", report.BudgetCap.Tier)
	}
	if !report.BudgetCap.ReadOK {
		t.Errorf("BudgetCap.ReadOK = false, want true (the budgets read succeeded)")
	}
}

func TestBuildAuditReport_OverThresholdBudgetWarnsButPasses(t *testing.T) {
	// A teacher-set cap over the warn threshold is a non-gating warning: the
	// audit still passes (exit 0), but the report flags it.
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"budgets": []map[string]any{{
				"budget_scope":          orgpolicy.BudgetScopeOrg,
				"budget_product_sku":    orgpolicy.BudgetProductSKUActions,
				"budget_amount":         orgpolicy.BudgetWarnThreshold + 25,
				"prevent_further_usage": true,
			}}})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if !report.LockdownComplete {
		t.Errorf("an over-threshold budget is advisory; LockdownComplete must stay true")
	}
	if !report.BudgetCap.isWarn() {
		t.Errorf("BudgetCap should be a warning; got tier %q", report.BudgetCap.Tier)
	}
}

func TestBuildAuditReport_BudgetReadFailureIsAdvisory(t *testing.T) {
	// A budgets read failure (no billing visibility / token lacks
	// Administration: Read) must NOT fail the audit — it's inconclusive and
	// advisory, distinct from a successful read showing a missing cap.
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Forbidden"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if !report.LockdownComplete {
		t.Errorf("a budgets read failure must not fail the audit (advisory)")
	}
	if report.BudgetCap.ReadOK {
		t.Errorf("BudgetCap.ReadOK = true on a 403, want false")
	}
	if report.BudgetCap.isCritical() {
		t.Errorf("an unreadable budget must not be critical")
	}
}

func TestBuildAuditReport_AlertOnlyBudgetIsCritical(t *testing.T) {
	// A $0 budget that only alerts (no hard stop) still lets Actions spend, so
	// it classifies as missing → critical.
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"budgets": []map[string]any{{
				"budget_scope":          orgpolicy.BudgetScopeOrg,
				"budget_product_sku":    orgpolicy.BudgetProductSKUActions,
				"budget_amount":         0,
				"prevent_further_usage": false,
			}}})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if report.LockdownComplete {
		t.Errorf("an alert-only $0 budget doesn't stop spend; must be critical drift")
	}
	if report.BudgetCap.Tier != string(orgpolicy.BudgetMissing) {
		t.Errorf("BudgetCap.Tier = %q, want missing (alert-only)", report.BudgetCap.Tier)
	}
}

func TestBuildAuditReport_LargeAlertOnlyBudgetIsCritical(t *testing.T) {
	// A large alert-only budget ($100, prevent_further_usage:false) stops NO
	// spend — it must be critical drift, not a passing >$50 "warn". Guards the
	// classifier's hard-stop-before-amount ordering: a regression that checked
	// the amount first would wrongly let this pass the deploy gate.
	live := orgLiveFromSettings("team")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isBudgetsPath(r) {
			_ = json.NewEncoder(w).Encode(map[string]any{"budgets": []map[string]any{{
				"budget_scope":          orgpolicy.BudgetScopeOrg,
				"budget_product_sku":    orgpolicy.BudgetProductSKUActions,
				"budget_amount":         100,
				"prevent_further_usage": false,
			}}})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(live)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	report := buildAuditReport(client, "cs50-fall-2026", "team")

	if report.LockdownComplete {
		t.Errorf("a large alert-only budget stops no spend; must be critical drift, not a passing warn")
	}
	if report.BudgetCap.Tier != string(orgpolicy.BudgetMissing) {
		t.Errorf("BudgetCap.Tier = %q, want missing (large alert-only)", report.BudgetCap.Tier)
	}
}

func TestAuditReport_RenderHumanShowsAllThreeSections(t *testing.T) {
	// Plain (forced-no-color) human render must show: the INCOMPLETE
	// banner, the unenforced checklist item, and the unreadable manual
	// section — the whole point of the command.
	report := auditReport{
		Org:              "cs50",
		Plan:             "team",
		ReadOK:           true,
		LockdownComplete: false,
		Enforced:         []auditSetting{{Field: "default_repository_permission", Desc: `base repository permission "none"`, Critical: true}},
		Unenforced: []auditSetting{{
			Field: "members_can_delete_repositories", Desc: "member repo deletion/transfer disabled",
			Critical: true, Fix: `uncheck "Allow members to delete or transfer repositories for this organization"`,
		}},
		ManualUnreadable: orgpolicy.ManualHardeningSteps("cs50"),
		SettingsURL:      "https://github.com/organizations/cs50/settings/member_privileges",
	}

	var buf bytes.Buffer
	report.renderHuman(ui.NewForced(&buf, false))
	got := buf.String()
	for _, want := range []string{
		"cs50: member-privilege lockdown INCOMPLETE",
		"Verified (read from the API)",
		// Each verified setting is listed with a checked box (plain mode).
		`[x] base repository permission "none"`,
		"Action required",
		`uncheck "Allow members to delete or transfer repositories`,
		"Confirm by hand",
		"Open https://github.com/organizations/cs50/settings/member_privileges and confirm",
		`1. Set "App access requests"`,
		"https://github.com/organizations/cs50/settings/member_privileges",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("human render missing %q:\n%s", want, got)
		}
	}
}

func TestAuditReport_RenderJSONStable(t *testing.T) {
	report := auditReport{
		Org:              "cs50",
		Plan:             "team",
		ReadOK:           true,
		LockdownComplete: true,
		Enforced:         []auditSetting{},
		Unenforced:       []auditSetting{},
		ManualUnreadable: orgpolicy.ManualHardeningSteps("cs50"),
		SettingsURL:      "https://github.com/organizations/cs50/settings/member_privileges",
	}
	var buf bytes.Buffer
	if err := report.renderJSON(&buf); err != nil {
		t.Fatalf("renderJSON: %v", err)
	}
	var round auditReport
	if err := json.Unmarshal(buf.Bytes(), &round); err != nil {
		t.Fatalf("round-trip unmarshal: %v", err)
	}
	if round.Org != "cs50" || !round.LockdownComplete || !round.ReadOK {
		t.Errorf("round-tripped report lost fields: %+v", round)
	}
	// `>` in fix instructions must stay literal (HTML escaping off).
	if strings.Contains(buf.String(), "\\u003e") {
		t.Errorf("JSON should not HTML-escape '>': %s", buf.String())
	}
}
