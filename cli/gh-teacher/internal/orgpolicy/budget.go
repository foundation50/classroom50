package orgpolicy

import "fmt"

// Budget policy: Classroom 50 wants a $0 GitHub Actions spending cap so a
// runaway autograde workflow can't rack up a bill. Budgets live on a separate
// REST endpoint (/organizations/{org}/settings/billing/budgets) with a
// different shape and token scope than the member-privilege PATCH fields, so
// they're modeled as their own concern rather than a MemberDefaultSetting. This
// file is the stdlib-only desired-state + classifier seam shared by init
// (reconciliation) and audit; the transport lives in internal/githubapi.

// Desired-state constants for the Actions budget cap. The create body pins
// these; the classifier matches against them.
const (
	BudgetProductSKUActions  = "actions"
	BudgetScopeOrg           = "organization"
	BudgetTypeProductPricing = "ProductPricing"
	// BudgetWarnThreshold is the dollar amount above which an existing
	// teacher-set budget is flagged as a (non-critical) warning: a cap this
	// large defeats the point of a guardrail, but it's the teacher's call, so
	// we warn rather than fail.
	BudgetWarnThreshold = 50
)

// Budget is the subset of a GitHub budget object we classify on. Unknown fields
// are ignored on decode (the reader tolerates schema growth).
type Budget struct {
	BudgetScope         string `json:"budget_scope"`
	BudgetProductSKU    string `json:"budget_product_sku"`
	BudgetAmount        int    `json:"budget_amount"`
	PreventFurtherUsage bool   `json:"prevent_further_usage"`
}

// BudgetTier is the classification of an org's Actions budget against policy.
type BudgetTier string

const (
	// BudgetMissing: no org-scoped Actions budget exists — critical drift, the
	// guardrail is absent.
	BudgetMissing BudgetTier = "missing"
	// BudgetEnforced: the exact desired cap ($0, hard-stop) is in place.
	BudgetEnforced BudgetTier = "enforced"
	// BudgetOK: a teacher-set cap within an acceptable range (>$0 and
	// <=BudgetWarnThreshold, hard-stop) — not the ideal $0, but fine.
	BudgetOK BudgetTier = "ok"
	// BudgetWarn: a teacher-set cap over BudgetWarnThreshold — surfaced as a
	// warning, never gates.
	BudgetWarn BudgetTier = "warn"
)

// BudgetVerdict is ClassifyBudget's result: the tier plus the matched budget's
// amount and hard-stop flag (both zero when the tier is BudgetMissing).
type BudgetVerdict struct {
	Tier          BudgetTier
	Amount        int
	PreventsUsage bool
}

// ClassifyBudget finds the org-scoped Actions budget among the org's budgets
// and classifies it against policy. Tiers:
//   - missing: no org-scoped Actions budget → critical.
//   - enforced: amount 0 with prevent_further_usage → the desired cap.
//   - ok: 0 < amount <= BudgetWarnThreshold with prevent_further_usage.
//   - warn: amount > BudgetWarnThreshold with prevent_further_usage.
//
// An alert-only budget (prevent_further_usage=false) is treated as missing at
// ANY amount: it emails but never stops spend, so the hard-stop guardrail isn't
// in place — a large alert-only budget must not pass the audit as a mere
// warning. The hard-stop check therefore precedes the amount tiers.
func ClassifyBudget(budgets []Budget) BudgetVerdict {
	b, found := findActionsBudget(budgets)
	if !found {
		return BudgetVerdict{Tier: BudgetMissing}
	}
	v := BudgetVerdict{Amount: b.BudgetAmount, PreventsUsage: b.PreventFurtherUsage}
	switch {
	case !b.PreventFurtherUsage:
		// Alert-only stops no spend regardless of amount: the guardrail isn't
		// actually in place, so it's missing (not a warning).
		v.Tier = BudgetMissing
	case b.BudgetAmount > BudgetWarnThreshold:
		v.Tier = BudgetWarn
	case b.BudgetAmount == 0:
		v.Tier = BudgetEnforced
	default:
		v.Tier = BudgetOK
	}
	return v
}

// OrgBudgetsURL is the org billing-budgets settings page where a teacher can
// view/adjust spending caps by hand. Single-sourced (like the other org URL
// helpers) so init and audit can't drift.
func OrgBudgetsURL(org string) string {
	return fmt.Sprintf("https://github.com/organizations/%s/settings/billing/budgets", org)
}

// findActionsBudget returns the org-scoped Actions budget, if present. GitHub
// allows one budget per scope+SKU, so the first match is authoritative.
func findActionsBudget(budgets []Budget) (Budget, bool) {
	for _, b := range budgets {
		if b.BudgetScope == BudgetScopeOrg && b.BudgetProductSKU == BudgetProductSKUActions {
			return b, true
		}
	}
	return Budget{}, false
}
