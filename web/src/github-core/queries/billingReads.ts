import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"
import {
  classifyBudget,
  orgBudgetsApiPath,
  type BudgetVerdict,
  type BudgetsListResponse,
} from "@/orgPolicy/budget"

const log = logger.scope(LOG_SCOPE_GITHUB_SETUP)

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

// Fields typed optional because the usage-summary endpoint is in public preview
// and its shape may change; a renamed field then reads as absent (handled
// below) rather than a confident-but-wrong 0.
type BillingUsageItem = {
  product?: string
  sku?: string
  unitType?: string
  // grossQuantity is total usage (e.g. all Actions minutes run); netQuantity is
  // only the BILLABLE remainder after the plan's included quota, so it reads 0
  // while you're still within quota. We want total usage, so sum grossQuantity.
  grossQuantity?: number
  // netAmount is post-quota, post-discount USD actually billed (0 within quota).
  netAmount?: number
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

// Advisory billing reads never block the kill switch: an expected 403 (no
// billing visibility) / 404 / 410 (endpoint moved) degrades silently to null,
// but an unexpected failure (5xx, network, or a non-API error such as a shape
// change throwing a TypeError) is logged so real breakage is observable rather
// than indistinguishable from "no billing".
function billingReadFailed(what: string, org: string, err: unknown): null {
  const unexpected = !(err instanceof GitHubAPIError) || err.status >= 500
  if (unexpected) log.warn(`${what} read failed unexpectedly`, { org, err })
  return null
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
    // The request is already scoped server-side via ?product=actions; match
    // loosely (substring) so a display-name value like "GitHub Actions" from
    // the preview endpoint doesn't silently drop every item.
    const items = (resp.usageItems ?? []).filter((i) =>
      i.product?.toLowerCase().includes(USAGE_PRODUCT_ACTIONS),
    )
    const minutes = items
      .filter((i) => i.unitType?.toLowerCase() === USAGE_UNIT_MINUTES)
      .reduce((sum, i) => sum + (i.grossQuantity ?? 0), 0)
    const netAmountUsd = items.reduce((sum, i) => sum + (i.netAmount ?? 0), 0)
    // Non-empty report that sums to nothing usually means the preview contract
    // drifted (renamed quantity/amount fields), not genuinely zero usage —
    // treat as unavailable rather than confidently showing "0 min / $0.00".
    if (items.length > 0 && minutes === 0 && netAmountUsd === 0) {
      log.warn("actions usage summary returned only zero quantities", { org })
      return null
    }
    return { minutes: Math.round(minutes), netAmountUsd }
  } catch (err) {
    return billingReadFailed("actions usage", org, err)
  }
}

// Included Actions minutes per month by GitHub plan. GitHub doesn't expose the
// quota via the API — it's a fixed per-plan allowance — so we map it from the
// org's plan.name (GET /orgs/{org}, owner-only). null when the plan is
// unknown/unrecognized (hide the quota bar rather than guess).
//
// Source: GitHub Actions billing docs; verified 2026-07-22. If GitHub changes
// plan quotas this map drifts silently — re-verify against the docs when
// touching it.
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
    return billingReadFailed("actions budget", org, err)
  }
}
