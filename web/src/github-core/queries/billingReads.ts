import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"
import {
  classifyBudget,
  orgBudgetsApiPath,
  type BudgetVerdict,
  type BudgetsListResponse,
} from "@/orgPolicy/budget"

// GitHub Actions usage for the current billing month, read from the enhanced
// billing platform's usage-summary endpoint. The legacy
// /orgs/{org}/settings/billing/actions endpoint is 410 Gone; this consolidated
// endpoint reports usage across every metered product, so we filter to Actions.
//
// Requires org-admin (the Org Settings page is owner-gated). Best-effort: any
// read failure — 403 (no billing visibility / not enhanced-billing),
// 404/410, or transient — degrades to "unavailable" rather than throwing, so a
// billing-blind org still renders the kill switch.

const USAGE_PRODUCT_ACTIONS = "actions"
const USAGE_UNIT_MINUTES = "minutes"

type BillingUsageItem = {
  product: string
  sku: string
  unitType: string
  // grossQuantity is total usage (e.g. all Actions minutes run); netQuantity is
  // only the BILLABLE remainder after the plan's included quota, so it reads 0
  // while you're still within quota. We want total usage, so sum grossQuantity.
  grossQuantity: number
  // netAmount is post-quota, post-discount USD actually billed (0 within quota).
  netAmount: number
}

type BillingUsageSummary = {
  usageItems?: BillingUsageItem[]
}

export type OrgActionsUsage = {
  // Total Actions minutes consumed this month across all runner SKUs (includes
  // minutes covered by the plan's included quota).
  minutes: number
  // Net (post-quota, post-discount) USD billed for Actions this month.
  netAmountUsd: number
}

function orgUsageSummaryApiPath(org: string): string {
  // product filter narrows the summary to Actions; year/month default to the
  // current billing period server-side.
  return `/organizations/${org}/settings/billing/usage/summary?product=${USAGE_PRODUCT_ACTIONS}`
}

// Current-month Actions usage, or null when billing isn't readable/available.
export async function getOrgActionsUsage(
  client: GitHubClient,
  org: string,
): Promise<OrgActionsUsage | null> {
  try {
    const resp = await client.request<BillingUsageSummary>(
      orgUsageSummaryApiPath(org),
    )
    const items = (resp.usageItems ?? []).filter(
      (i) => i.product?.toLowerCase() === USAGE_PRODUCT_ACTIONS,
    )
    const minutes = items
      .filter((i) => i.unitType?.toLowerCase() === USAGE_UNIT_MINUTES)
      .reduce((sum, i) => sum + (i.grossQuantity ?? 0), 0)
    const netAmountUsd = items.reduce((sum, i) => sum + (i.netAmount ?? 0), 0)
    return { minutes: Math.round(minutes), netAmountUsd }
  } catch (err) {
    // A 403 (no billing visibility) / 404 / 410 (endpoint moved) / transient
    // failure is advisory — never block the kill switch on missing billing.
    if (err instanceof GitHubAPIError) return null
    return null
  }
}

// Included Actions minutes per month by GitHub plan. GitHub doesn't expose the
// quota via the API — it's a fixed per-plan allowance — so we map it from the
// org's plan.name (GET /orgs/{org}, owner-only). Source: GitHub Actions billing
// docs. null when the plan is unknown/unrecognized (hide the quota bar rather
// than guess).
const PLAN_INCLUDED_ACTIONS_MINUTES: Record<string, number> = {
  free: 2000,
  // "Free for organizations" also reports as "free"; both are 2000.
  pro: 3000,
  team: 3000,
  business: 50000, // GitHub Enterprise Cloud reports plan.name "business".
  enterprise: 50000,
}

export function includedActionsMinutes(
  planName: string | undefined,
): number | null {
  if (!planName) return null
  return PLAN_INCLUDED_ACTIONS_MINUTES[planName.toLowerCase()] ?? null
}

// The org's Actions budget classification (whether a hard-stop cap is set, and
// at what amount), or null when billing budgets aren't readable. Reuses the
// shared classifyBudget so the section and the policy audit agree.
export async function getOrgActionsBudget(
  client: GitHubClient,
  org: string,
): Promise<BudgetVerdict | null> {
  try {
    const resp = await client.request<BudgetsListResponse>(
      orgBudgetsApiPath(org),
    )
    return classifyBudget(resp.budgets ?? [])
  } catch (err) {
    if (err instanceof GitHubAPIError) return null
    return null
  }
}
