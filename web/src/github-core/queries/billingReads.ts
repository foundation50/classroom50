import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

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
  netAmount: number
  netQuantity: number
}

type BillingUsageSummary = {
  usageItems?: BillingUsageItem[]
}

export type OrgActionsUsage = {
  // Whole Actions minutes consumed this month across all runner SKUs.
  minutes: number
  // Net (post-discount) USD billed for Actions this month.
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
      .reduce((sum, i) => sum + (i.netQuantity ?? 0), 0)
    const netAmountUsd = items.reduce((sum, i) => sum + (i.netAmount ?? 0), 0)
    return { minutes: Math.round(minutes), netAmountUsd }
  } catch (err) {
    // A 403 (no billing visibility) / 404 / 410 (endpoint moved) / transient
    // failure is advisory — never block the kill switch on missing billing.
    if (err instanceof GitHubAPIError) return null
    return null
  }
}
