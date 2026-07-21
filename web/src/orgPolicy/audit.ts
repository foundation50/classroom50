// Read-only org audit — the web mirror of the CLI's buildAuditReport.
// Deliberate divergence: the CLI is three-state (OK / WARN / FAIL), but the GUI
// collapses WARN into FAIL — any drift is actionable (deriveVerdict).

import type { GitHubClient } from "@/github-core/client"
import {
  checkBranchProtection,
  checkConfigRepoDefaultBranch,
  checkOrgActions,
  checkOrgBudget,
  checkOrgDefaultBranch,
  checkOrgDefaults,
  checkOrgPrCreation,
  checkPages,
  checkReusableWorkflowAccess,
  checkWorkflowPermissions,
  RECOMMENDED_ORG_DEFAULT_BRANCH,
  type CheckVerdict,
} from "@/github-core/orgChecks"
import { checkRulesets } from "@/github-core/rulesets"
import { CONFIG_REPO } from "@/util/configRepo"
import {
  manualHardeningSteps,
  memberPrivilegesUrl,
  type DefaultVerdict,
  type ManualStep,
  type MemberDefaultSetting,
} from "./desiredState"

export type AuditVerdict = "ok" | "fail"

export type ConcernId =
  | "orgDefaults"
  | "orgActions"
  | "orgBudget"
  | "orgPrCreation"
  | "branchProtection"
  | "workflowPermissions"
  | "reusableWorkflowAccess"
  | "pages"
  | "rulesets"

export type ConcernCheck = {
  id: ConcernId
  title: string
  verdict: CheckVerdict
  // The GitHub settings page where a teacher can inspect/fix this concern.
  settingsUrl: string
}

export type OrgAuditReport = {
  org: string
  plan: string | undefined
  verdict: AuditVerdict
  // readOk is false when GET /orgs/{org} itself failed — the member-default
  // audit is inconclusive (distinct from "read fine, all enforced").
  readOk: boolean
  // lockdownComplete mirrors the CLI: no critical member-default is unenforced.
  lockdownComplete: boolean
  // Per-field member-default drift, each carrying its manualFix.
  unenforcedDefaults: MemberDefaultSetting[]
  // The full member-default lockdown we configure, each with whether the live
  // org value matches — so teachers see every permission we set, not just the
  // drifted ones. Empty when the org couldn't be read.
  defaultVerdicts: DefaultVerdict[]
  // Per-concern check verdicts (Actions, Pages, rulesets, …).
  concerns: ConcernCheck[]
  // The four API-less settings the teacher confirms by hand; never fail.
  manualUnreadable: ManualStep[]
  // Advisory recommendations that never affect `verdict` — e.g. the org's
  // default repository branch name isn't `main`. Not enforceable via API, so
  // surfaced as a "highly recommended, not required" hand-fix.
  recommendations: OrgRecommendation[]
}

// A non-blocking, highly-recommended hand-fix surfaced by the audit (never
// affects the verdict). Two kinds:
//   - orgDefaultBranch: the org's default-branch *setting* isn't `main`. Not
//     API-writable (PATCH /orgs ignores it), so hand-fix only.
//   - configRepoDefaultBranch: the classroom50 config *repo* drifted off `main`.
//     API-renameable, so the pane offers a one-click rename (behind a warning:
//     already-accepted student shims pin the old branch).
export type OrgRecommendation =
  | {
      id: "orgDefaultBranch"
      title: string
      detail: string
      settingsUrl: string
    }
  | {
      id: "configRepoDefaultBranch"
      title: string
      detail: string
      settingsUrl: string
    }

const CONCERN_TITLES: Record<ConcernId, string> = {
  orgDefaults: "Member-privilege lockdown",
  orgActions: "Actions permissions",
  orgBudget: "Actions spending cap",
  orgPrCreation: "Actions pull request creation",
  branchProtection: "Branch protection",
  workflowPermissions: "Workflow permissions",
  reusableWorkflowAccess: "Reusable workflow access",
  pages: "GitHub Pages",
  rulesets: "Branch protection rulesets",
}

// The GitHub settings page each concern maps to, so a teacher can jump straight
// to where they'd fix it. Org-level concerns point at org settings; repo-level
// concerns at the classroom50 config repo.
function concernSettingsUrl(id: ConcernId, org: string): string {
  const orgBase = `https://github.com/organizations/${org}/settings`
  const repoBase = `https://github.com/${org}/${CONFIG_REPO}/settings`
  switch (id) {
    case "orgDefaults":
      return memberPrivilegesUrl(org)
    case "orgActions":
    case "orgPrCreation":
      return `${orgBase}/actions`
    case "orgBudget":
      return `${orgBase}/billing/budgets`
    case "rulesets":
      return `${orgBase}/rules`
    case "branchProtection":
      return `${repoBase}/branches`
    case "reusableWorkflowAccess":
    case "workflowPermissions":
      return `${repoBase}/actions`
    case "pages":
      return `${repoBase}/pages`
  }
}

// Any drift fails the audit — stricter than the CLI, which warns on
// non-critical drift (see header). An unreadable concern also fails: a partial
// read outage is "needs attention", not a clean bill.
function deriveVerdict(
  readOk: boolean,
  lockdownComplete: boolean,
  concerns: ConcernCheck[],
): AuditVerdict {
  if (!readOk) return "fail"
  if (!lockdownComplete) return "fail"
  const anyUnresolved = concerns.some(
    (c) => c.verdict.state === "unenforced" || c.verdict.state === "unreadable",
  )
  return anyUnresolved ? "fail" : "ok"
}

export async function buildOrgAuditReport(
  client: GitHubClient,
  org: string,
  plan: string | undefined,
): Promise<OrgAuditReport> {
  // All concern checks run in parallel — independent reads, none throw (each
  // swallows its error into a verdict).
  const [
    defaults,
    actions,
    budget,
    prCreation,
    branchProtection,
    workflowPermissions,
    reusableAccess,
    pages,
    rulesets,
    orgDefaultBranch,
    configRepoDefaultBranch,
  ] = await Promise.all([
    checkOrgDefaults(client, org, plan),
    checkOrgActions(client, org),
    checkOrgBudget(client, org),
    checkOrgPrCreation(client, org),
    checkBranchProtection(client, org),
    checkWorkflowPermissions(client, org),
    checkReusableWorkflowAccess(client, org),
    checkPages(client, org),
    checkRulesets(client, org),
    checkOrgDefaultBranch(client, org),
    checkConfigRepoDefaultBranch(client, org),
  ])

  const readOk = defaults.verdict.state !== "unreadable"
  const unenforcedDefaults =
    defaults.classification?.verdicts
      .filter((v) => !v.enforced)
      .map((v) => v.setting) ?? []
  const defaultVerdicts = defaults.classification?.verdicts ?? []
  // lockdownComplete mirrors the CLI: critical defaults only. Non-critical drift
  // leaves it true but still fails the verdict via the orgDefaults concern being
  // "unenforced" (see deriveVerdict).
  const lockdownComplete =
    readOk && !(defaults.classification?.criticalMissed ?? false)

  const concerns: ConcernCheck[] = (
    [
      { id: "orgDefaults", verdict: defaults.verdict },
      { id: "orgActions", verdict: actions },
      { id: "orgBudget", verdict: budget },
      { id: "orgPrCreation", verdict: prCreation },
      { id: "branchProtection", verdict: branchProtection },
      { id: "workflowPermissions", verdict: workflowPermissions },
      { id: "reusableWorkflowAccess", verdict: reusableAccess },
      { id: "pages", verdict: pages },
      { id: "rulesets", verdict: rulesets },
    ] as const
  ).map(({ id, verdict }) => ({
    id,
    title: CONCERN_TITLES[id],
    verdict,
    settingsUrl: concernSettingsUrl(id, org),
  }))
  // Sort alphabetically by title for predictable scanning.
  concerns.sort((a, b) => a.title.localeCompare(b.title))

  // Advisory-only recommendations — never affect the verdict.
  const recommendations: OrgRecommendation[] = []
  // The classroom50 config repo drifted off `main`. API-renameable, so the pane
  // offers a one-click rename (guarded: it may strand student shim refs). Listed
  // first — it's the actionable one.
  if (
    configRepoDefaultBranch !== null &&
    configRepoDefaultBranch !== RECOMMENDED_ORG_DEFAULT_BRANCH
  ) {
    recommendations.push({
      id: "configRepoDefaultBranch",
      title: "Config repo default branch",
      detail: configRepoDefaultBranch,
      settingsUrl: `https://github.com/${org}/${CONFIG_REPO}/settings/branches`,
    })
  }
  // The org default branch *setting* isn't `main`. GitHub has no API to set it,
  // so we can't "fix it" — only remind.
  if (
    orgDefaultBranch !== null &&
    orgDefaultBranch !== RECOMMENDED_ORG_DEFAULT_BRANCH
  ) {
    recommendations.push({
      id: "orgDefaultBranch",
      title: "Repository default branch",
      detail: orgDefaultBranch,
      settingsUrl: `https://github.com/organizations/${org}/settings/repository-defaults`,
    })
  }

  return {
    org,
    plan,
    verdict: deriveVerdict(readOk, lockdownComplete, concerns),
    readOk,
    lockdownComplete,
    unenforcedDefaults,
    defaultVerdicts,
    concerns,
    manualUnreadable: manualHardeningSteps(org),
    recommendations,
  }
}
