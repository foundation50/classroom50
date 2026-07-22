// Web mirror of the CLI's org Actions budget-cap policy seam
// (cli/gh-teacher/internal/orgpolicy/budget.go).
//
// Classroom 50 wants a $0 GitHub Actions spending cap so a runaway autograde
// workflow can't run up a bill. Must stay a 1:1 mirror of the CLI's
// Budget/ClassifyBudget — a divergence here is a parity bug.

export const BUDGET_PRODUCT_SKU_ACTIONS = "actions"
export const BUDGET_SCOPE_ORG = "organization"
export const BUDGET_TYPE_PRODUCT_PRICING = "ProductPricing"
// Dollar amount above which an existing teacher-set budget is a (non-critical)
// warning: a cap this large defeats the guardrail, but it's the teacher's call.
export const BUDGET_WARN_THRESHOLD = 50

// The subset of a GitHub budget object we classify on. Unknown fields ignored.
export type Budget = {
  budget_scope?: string
  budget_product_sku?: string
  budget_amount?: number
  prevent_further_usage?: boolean
}

// The org billing-budgets endpoint returns budgets under a "budgets" key.
export type BudgetsListResponse = {
  budgets?: Budget[]
}

// The classification of an org's Actions budget against policy. Mirrors the
// CLI's BudgetTier.
export type BudgetTier = "missing" | "enforced" | "ok" | "warn"

export type BudgetVerdict = {
  tier: BudgetTier
  amount: number
  preventsUsage: boolean
}

// The org billing-budgets settings page — where a teacher views/adjusts caps.
export function orgBudgetsUrl(org: string): string {
  return `https://github.com/organizations/${org}/settings/billing/budgets`
}

// The org billing-budgets REST endpoint (list + create). Single-sourced so the
// audit read and the setup create can't drift (mirrors the CLI's orgBudgetsPath).
export function orgBudgetsApiPath(org: string): string {
  return `/organizations/${org}/settings/billing/budgets`
}

function findActionsBudget(budgets: Budget[]): Budget | undefined {
  // GitHub allows one budget per scope+SKU, so the first match is authoritative.
  return budgets.find(
    (b) =>
      b.budget_scope === BUDGET_SCOPE_ORG &&
      b.budget_product_sku === BUDGET_PRODUCT_SKU_ACTIONS,
  )
}

// classifyBudget finds the org-scoped Actions budget and classifies it:
//   - missing: no org-scoped Actions budget (critical).
//   - enforced: amount 0 with prevent_further_usage (the desired cap).
//   - ok: 0 < amount <= BUDGET_WARN_THRESHOLD with prevent_further_usage.
//   - warn: amount > BUDGET_WARN_THRESHOLD with prevent_further_usage.
//
// An alert-only budget (prevent_further_usage=false) is treated as missing at
// ANY amount: it emails but never stops spend, so the hard-stop guardrail isn't
// in place — a large alert-only budget must not pass the audit as a mere
// warning. The hard-stop check therefore precedes the amount tiers.
export function classifyBudget(budgets: Budget[]): BudgetVerdict {
  const b = findActionsBudget(budgets)
  if (b === undefined) {
    return { tier: "missing", amount: 0, preventsUsage: false }
  }
  const amount = b.budget_amount ?? 0
  const preventsUsage = b.prevent_further_usage ?? false
  let tier: BudgetTier
  if (!preventsUsage) {
    // Alert-only stops no spend regardless of amount: the guardrail isn't
    // actually in place, so it's missing (not a warning).
    tier = "missing"
  } else if (amount > BUDGET_WARN_THRESHOLD) {
    tier = "warn"
  } else if (amount === 0) {
    tier = "enforced"
  } else {
    tier = "ok"
  }
  return { tier, amount, preventsUsage }
}
