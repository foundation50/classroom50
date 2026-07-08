// Per-concern repair dispatcher for the org policy audit. Maps each ConcernId to
// the mutation that restores its setting, so the settings page can offer a
// per-concern "Fix it" button. Kept in its own module (not orgChecks.ts) to
// avoid an import cycle: mutations.ts already imports orgChecks.ts for
// repairOrgDefaults.

import type { GitHubClient } from "@/hooks/github/client"
import {
  ensureBranchProtection,
  ensureOrgActionsEnabled,
  ensureOrgCanCreatePullRequests,
  ensurePages,
  ensureReusableWorkflowAccess,
  ensureWorkflowPermissions,
} from "@/hooks/github/mutations"
import { CONFIG_REPO, repairOrgDefaults } from "@/hooks/github/orgChecks"
import { repairRulesets } from "@/hooks/github/rulesets"
import type { ConcernId } from "./audit"

// Whether a concern can be repaired by an API call. The four manual-only
// member-privilege settings have no API and are excluded by design; every
// concern here is API-repairable.
export const REPAIRABLE_CONCERNS: ReadonlySet<ConcernId> = new Set<ConcernId>([
  "orgDefaults",
  "orgActions",
  "orgPrCreation",
  "branchProtection",
  "workflowPermissions",
  "reusableWorkflowAccess",
  "pages",
  "rulesets",
])

// Result of a repair attempt. `unfixableFields` lists member-default fields the
// API accepted but that didn't stick on read-back — silently overridden by an
// enterprise policy (200 but ignored). Plan-gated fields the API rejected
// (403/422) are excluded. Only populated for orgDefaults.
//
// `unresolved` is set when a concern-level repair (branchProtection, rulesets)
// did not complete. We deliberately do NOT assert a cause: a failed write maps
// ambiguously to permissions, an org/enterprise policy, a rate limit, a
// malformed body, or a still-initializing repo (see the plan's Sources). We
// carry the mutation's own `message` (which names the attempted action and the
// settings URL) and a `transient` flag so the UI can offer a retry instead of a
// permanent "needs manual setup" for temporary failures.
export type RepairResult = {
  unfixableFields: string[]
  unresolved?: { message: string; transient: boolean }
}

// Restore a single concern's required setting. Plan is needed for orgDefaults
// (the member-default lockdown is plan-filtered); ignored by the others.
export async function repairConcern(
  client: GitHubClient,
  org: string,
  id: ConcernId,
  plan: string | undefined,
): Promise<RepairResult> {
  switch (id) {
    case "orgDefaults": {
      const result = await repairOrgDefaults(client, org, plan)
      return { unfixableFields: result.enterprisePinned.map((s) => s.field) }
    }
    case "orgActions":
      await ensureOrgActionsEnabled(client, org)
      return { unfixableFields: [] }
    case "orgPrCreation":
      await ensureOrgCanCreatePullRequests(client, org)
      return { unfixableFields: [] }
    case "branchProtection": {
      const result = await ensureBranchProtection(
        client,
        org,
        CONFIG_REPO,
        "main",
      )
      if (result.status === "warning") {
        // branch_not_found means the repo is still initializing — a transient
        // state, not a manual-setup situation. Everything else is reported as
        // "couldn't complete" without asserting the cause.
        return {
          unfixableFields: [],
          unresolved: {
            message: result.message,
            transient: result.reason === "branch_not_found",
          },
        }
      }
      return { unfixableFields: [] }
    }
    case "workflowPermissions":
      await ensureWorkflowPermissions(client, org, CONFIG_REPO)
      return { unfixableFields: [] }
    case "reusableWorkflowAccess":
      await ensureReusableWorkflowAccess(client, org, CONFIG_REPO)
      return { unfixableFields: [] }
    case "pages":
      await ensurePages(client, org, CONFIG_REPO)
      return { unfixableFields: [] }
    case "rulesets": {
      const result = await repairRulesets(client, org)
      if (result.status === "warning") {
        // A rulesets warning (some rulesets failed, or the list call failed) is
        // reported as unresolved. We can't tell a policy block from a validation
        // error, so it's non-transient but cause-neutral.
        return {
          unfixableFields: [],
          unresolved: { message: result.message, transient: false },
        }
      }
      return { unfixableFields: [] }
    }
  }
}
