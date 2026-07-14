// Read-only org/repo policy checks — the non-mutating half of the
// check*/repair* split. The audit (useGetOrgAudit) and the centralized Org
// Settings page consume these to render drift verdicts without writing. Each
// check tolerates 404/403 with a verdict rather than throwing, so a single
// unreadable concern never breaks the whole audit.

import type { GitHubClient } from "./client"
import { GitHubAPIError } from "./errors"
import {
  classifyDefaults,
  memberDefaultSettings,
  type ClassifyResult,
  type MemberDefaultSetting,
} from "@/orgPolicy/desiredState"
import { logger } from "@/lib/logger"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"

const log = logger.scope("github:orgChecks")

// The org "Repository default branch name" we recommend. Not API-writable
// (PATCH /orgs ignores it), so it's surfaced as an advisory recommendation only.
export const RECOMMENDED_ORG_DEFAULT_BRANCH = DEFAULT_BRANCH

// A concern's read-only state: enforced means the live value already matches
// the desired policy; unenforced means it drifted; unreadable means the read
// itself failed (permission/transient) so the verdict is inconclusive.
export type CheckState = "enforced" | "unenforced" | "unreadable"

export type CheckVerdict = {
  state: CheckState
  detail?: string
}

// The `detail` string for a failed read, distinguishing an HTTP status from a
// non-API error. Shared so every "unreadable" verdict phrases it identically.
export function readFailedDetail(err: unknown): string {
  if (err instanceof GitHubAPIError) {
    return `read failed (${err.status})`
  }
  return "read failed"
}

function unreadableFrom(err: unknown): CheckVerdict {
  if (err instanceof GitHubAPIError && err.status === 404) {
    return { state: "unenforced", detail: "not configured" }
  }
  return { state: "unreadable", detail: readFailedDetail(err) }
}

// orgDefaults: GET /orgs/{org}, classify against the plan-filtered desired
// member-default lockdown. Returns the full per-field classification so the
// settings page can list each unenforced field with its manualFix.
export async function checkOrgDefaults(
  client: GitHubClient,
  org: string,
  plan: string | undefined,
): Promise<{ verdict: CheckVerdict; classification?: ClassifyResult }> {
  try {
    const live = await client.request<Record<string, unknown>>(`/orgs/${org}`)
    const classification = classifyDefaults(live, plan)
    const allEnforced = classification.verdicts.every((v) => v.enforced)
    const state: CheckState = allEnforced ? "enforced" : "unenforced"
    return { verdict: { state }, classification }
  } catch (err) {
    return { verdict: unreadableFrom(err) }
  }
}

// The org's live "Repository default branch name" (default_repository_branch on
// GET /orgs/{org}). Returns the value so the audit can recommend switching to
// `main` when it differs. null when the org read failed (recommendation is then
// suppressed — it's advisory, not worth surfacing on a read outage).
export async function checkOrgDefaultBranch(
  client: GitHubClient,
  org: string,
): Promise<string | null> {
  try {
    const live = await client.request<{ default_repository_branch?: string }>(
      `/orgs/${org}`,
    )
    return live.default_repository_branch ?? null
  } catch {
    return null
  }
}

// The classroom50 config repo's live default branch. Returns it so the audit can
// recommend renaming to `main` when it drifted (org policy can seed a repo on
// `master`). null when the read failed or the repo doesn't exist yet — the
// recommendation is advisory and suppressed in both cases.
export async function checkConfigRepoDefaultBranch(
  client: GitHubClient,
  org: string,
): Promise<string | null> {
  try {
    const repo = await client.request<{ default_branch?: string }>(
      `/repos/${org}/${CONFIG_REPO}`,
    )
    return repo.default_branch ?? null
  } catch {
    return null
  }
}

type OrgActionsPermissions = {
  enabled_repositories: "all" | "none" | "selected"
  allowed_actions?: "all" | "local_only" | "selected"
}

// orgActions: GET /orgs/{org}/actions/permissions — enforced when Actions are
// enabled for all repos with all actions allowed.
export async function checkOrgActions(
  client: GitHubClient,
  org: string,
): Promise<CheckVerdict> {
  try {
    const perms = await client.request<OrgActionsPermissions>(
      `/orgs/${org}/actions/permissions`,
    )
    const enforced =
      perms.enabled_repositories === "all" && perms.allowed_actions === "all"
    return {
      state: enforced ? "enforced" : "unenforced",
      detail: enforced
        ? undefined
        : `enabled_repositories="${perms.enabled_repositories}", allowed_actions="${perms.allowed_actions ?? "unset"}"`,
    }
  } catch (err) {
    return unreadableFrom(err)
  }
}

type OrgWorkflowPermissions = {
  default_workflow_permissions: "read" | "write"
  can_approve_pull_request_reviews: boolean
}

// orgPrCreation: GET /orgs/{org}/actions/permissions/workflow — enforced when
// Actions may create/approve pull requests (Feedback PRs can open).
export async function checkOrgPrCreation(
  client: GitHubClient,
  org: string,
): Promise<CheckVerdict> {
  try {
    const perms = await client.request<OrgWorkflowPermissions>(
      `/orgs/${org}/actions/permissions/workflow`,
    )
    return {
      state: perms.can_approve_pull_request_reviews ? "enforced" : "unenforced",
    }
  } catch (err) {
    return unreadableFrom(err)
  }
}

type BranchProtection = {
  allow_force_pushes?: { enabled: boolean }
  allow_deletions?: { enabled: boolean }
}

// branchProtection: GET /repos/{org}/{repo}/branches/{branch}/protection —
// enforced when force-pushes and deletions are both disabled. When no branch is
// given, resolves the repo's actual default branch (org policy can seed the
// config repo on `master`), falling back to `main` only if that read fails.
export async function checkBranchProtection(
  client: GitHubClient,
  org: string,
  repo: string = CONFIG_REPO,
  branch?: string,
): Promise<CheckVerdict> {
  try {
    const targetBranch =
      branch ?? (await resolveRepoDefaultBranch(client, org, repo))
    const protection = await client.request<BranchProtection>(
      `/repos/${org}/${repo}/branches/${encodeURIComponent(targetBranch)}/protection`,
    )
    const enforced =
      protection.allow_force_pushes?.enabled === false &&
      protection.allow_deletions?.enabled === false
    return { state: enforced ? "enforced" : "unenforced" }
  } catch (err) {
    return unreadableFrom(err)
  }
}

// The repo's live default branch, falling back to `main` when the read fails —
// so a branch-relative check/audit targets the real branch even on a `master`
// config repo, without letting an advisory read outage throw.
async function resolveRepoDefaultBranch(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<string> {
  try {
    const data = await client.request<{ default_branch?: string }>(
      `/repos/${org}/${repo}`,
    )
    return data.default_branch || DEFAULT_BRANCH
  } catch {
    return DEFAULT_BRANCH
  }
}

type ReusableWorkflowAccess = {
  access_level: "none" | "organization" | "enterprise"
}

// reusableWorkflowAccess: GET /repos/{org}/{repo}/actions/permissions/access —
// enforced when the config repo's reusable workflows are org-accessible.
export async function checkReusableWorkflowAccess(
  client: GitHubClient,
  org: string,
  repo: string = CONFIG_REPO,
): Promise<CheckVerdict> {
  try {
    const access = await client.request<ReusableWorkflowAccess>(
      `/repos/${org}/${repo}/actions/permissions/access`,
    )
    return {
      state:
        access.access_level === "organization" ||
        access.access_level === "enterprise"
          ? "enforced"
          : "unenforced",
    }
  } catch (err) {
    return unreadableFrom(err)
  }
}

type PagesInfo = {
  build_type?: string
  public?: boolean
}

// pages: GET /repos/{org}/{repo}/pages — enforced when Pages builds from the
// workflow and the site is public (the unauthenticated config-repo site).
export async function checkPages(
  client: GitHubClient,
  org: string,
  repo: string = CONFIG_REPO,
): Promise<CheckVerdict> {
  try {
    const pages = await client.request<PagesInfo>(`/repos/${org}/${repo}/pages`)
    const enforced = pages.build_type === "workflow" && pages.public === true
    return { state: enforced ? "enforced" : "unenforced" }
  } catch (err) {
    return unreadableFrom(err)
  }
}

type RepoWorkflowPermissions = {
  default_workflow_permissions?: "read" | "write"
}

// workflowPermissions: GET /repos/{org}/{repo}/actions/permissions/workflow.
// A repo "read" is acceptable when the org also restricts write — the skeleton
// workflows declare their own workflow-level permissions, so the org default
// doesn't block them. Only repo "read" while the org *allows* write is a
// fixable drift.
export async function checkWorkflowPermissions(
  client: GitHubClient,
  org: string,
  repo: string = CONFIG_REPO,
): Promise<CheckVerdict> {
  try {
    const perms = await client.request<RepoWorkflowPermissions>(
      `/repos/${org}/${repo}/actions/permissions/workflow`,
    )
    if (perms.default_workflow_permissions === "write") {
      return { state: "enforced" }
    }

    try {
      const orgPerms = await client.request<RepoWorkflowPermissions>(
        `/orgs/${org}/actions/permissions/workflow`,
      )
      if (orgPerms.default_workflow_permissions !== "write") {
        return {
          state: "enforced",
          detail:
            "org policy defaults workflows to read; the skeleton workflows declare their own permissions",
        }
      }
    } catch {
      log.warn("org workflow-permissions policy unreadable, treating as drift")
      // Org policy unreadable — treat the repo "read" as drift.
    }

    return { state: "unenforced" }
  } catch (err) {
    return unreadableFrom(err)
  }
}

export type OrgDefaultsRepairResult = {
  // ok mirrors the CLI's "lockdown complete" = no critical field unenforced.
  ok: boolean
  // transient is set when a secondary-rate-limit aborted the apply; the caller
  // should surface a retry message rather than a drift checklist.
  transient: boolean
  // The unenforced settings after the authoritative read-back, each carrying
  // its manualFix for the settings page / wizard checklist.
  unenforced: MemberDefaultSetting[]
  // Fields the API accepted (200, no 403/422) yet that still didn't stick on
  // read-back — silently overridden by an enterprise policy. A subset of
  // `unenforced`, excluding plan-gated fields the API rejected.
  enterprisePinned: MemberDefaultSetting[]
  message: string
}

function orgDefaultsBody(
  settings: MemberDefaultSetting[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const s of settings) body[s.field] = s.value
  return body
}

// Read the org back and classify — the authoritative source of residual state,
// since a 200 on the PATCH isn't proof the values stuck (enterprise-pinned
// fields silently no-op). A read failure is reported as unverified (not
// success), so the caller surfaces "could not verify — retry".
async function verifyOrgDefaults(
  client: GitHubClient,
  org: string,
  plan: string | undefined,
): Promise<{
  ok: boolean
  verified: boolean
  unenforced: MemberDefaultSetting[]
}> {
  try {
    const live = await client.request<Record<string, unknown>>(`/orgs/${org}`)
    const { verdicts, criticalMissed } = classifyDefaults(live, plan)
    return {
      ok: !criticalMissed,
      verified: true,
      unenforced: verdicts.filter((v) => !v.enforced).map((v) => v.setting),
    }
  } catch (err) {
    // Read-back failed — don't manufacture success; report unverified.
    log.warn("org member-default read-back failed", { org, err })
    return { ok: false, verified: false, unenforced: [] }
  }
}

// The transient result returned when a secondary-rate-limit aborts an apply —
// the caller should surface a retry message, not a drift checklist.
function rateLimitedResult(org: string): OrgDefaultsRepairResult {
  return {
    ok: false,
    transient: true,
    unenforced: [],
    enterprisePinned: [],
    message: `${org}: hit a rate limit applying org member defaults; retry shortly.`,
  }
}

// repairOrgDefaults applies the full plan-filtered member-default lockdown,
// mirroring the CLI's applyOrgMemberDefaults: one combined PATCH /orgs/{org}; on
// a 403/422 (not a rate limit) drop to a per-field fallback; on a
// secondary-rate-limit abort as transient (don't amplify the throttle); then
// always read the org back and classify.
export async function repairOrgDefaults(
  client: GitHubClient,
  org: string,
  plan: string | undefined,
): Promise<OrgDefaultsRepairResult> {
  const settings = memberDefaultSettings(plan)

  // Fields the API rejected (403/422) in the per-field fallback — plan-gated,
  // not enterprise silent no-ops. Empty when the combined PATCH succeeded.
  let rejected = new Set<string>()

  try {
    await client.request(`/orgs/${org}`, {
      method: "PATCH",
      body: orgDefaultsBody(settings),
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      return rateLimitedResult(org)
    }
    if (
      err instanceof GitHubAPIError &&
      (err.status === 403 || err.status === 422)
    ) {
      const fallback = await repairOrgDefaultsPerField(client, org, settings)
      rejected = fallback.rejected
      if (fallback.transient) {
        return rateLimitedResult(org)
      }
    } else {
      throw err
    }
  }

  const { ok, verified, unenforced } = await verifyOrgDefaults(
    client,
    org,
    plan,
  )
  if (!verified) {
    // Read-back failed, so we can't claim the lockdown is complete.
    return {
      ok: false,
      transient: true,
      unenforced: [],
      enterprisePinned: [],
      message: `${org}: applied org member defaults but could not verify them (read-back failed); re-check shortly.`,
    }
  }
  // A field still unenforced after an accepted write (not API-rejected) is the
  // enterprise silent-no-op signal — GitHub returned 200 but ignored it.
  const enterprisePinned = unenforced.filter((s) => !rejected.has(s.field))
  return {
    ok,
    transient: false,
    unenforced,
    enterprisePinned,
    // Key the message on ANY drift (not just critical, which `ok` tracks) so the
    // setup board flags non-critical settings the check page would also show.
    message:
      unenforced.length === 0
        ? `${org}: org member-privilege lockdown applied.`
        : `${org}: org member-privilege lockdown incomplete — ${unenforced.length} setting(s) need manual attention.`,
  }
}

// The four repo-creation booleans are entangled at the API layer through the
// deprecated members_allowed_repository_creation_type field: sending any alone
// makes GitHub recompute that legacy field from the partial input and silently
// reset the omitted ones. They must always be PATCHed together.
// (https://github.com/integrations/terraform-provider-github/issues/3429)
const REPO_CREATION_FIELDS = new Set([
  "members_can_create_repositories",
  "members_can_create_private_repositories",
  "members_can_create_public_repositories",
  "members_can_create_internal_repositories",
])

// Per-field fallback for when the combined PATCH is rejected. Sends each field
// alone EXCEPT the entangled repo-creation booleans, which go in one grouped
// sub-PATCH. Records fields the API rejected (403/422) — plan-gated, not
// enterprise no-ops; a rate limit aborts. verifyOrgDefaults gives the drift
// verdict.
async function repairOrgDefaultsPerField(
  client: GitHubClient,
  org: string,
  settings: MemberDefaultSetting[],
): Promise<{ transient: boolean; rejected: Set<string> }> {
  const rejected = new Set<string>()
  const rateLimitAbort = (): { transient: boolean; rejected: Set<string> } => ({
    transient: true,
    rejected,
  })

  // One grouped body for the entangled repo-creation booleans (in scope for
  // this plan), plus the remaining fields applied individually.
  const repoCreation = settings.filter((s) => REPO_CREATION_FIELDS.has(s.field))
  const rest = settings.filter((s) => !REPO_CREATION_FIELDS.has(s.field))

  // Returns whether the write was accepted. Only a rate limit throws — never
  // rethrow other errors, or a mid-loop throw would escape repairOrgDefaults
  // before the authoritative read-back runs.
  const patchBody = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      await client.request(`/orgs/${org}`, { method: "PATCH", body })
      return true
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        throw err // bubble to the abort handler below
      }
      return false
    }
  }

  try {
    if (repoCreation.length > 0) {
      const accepted = await patchBody(orgDefaultsBody(repoCreation))
      if (!accepted) for (const s of repoCreation) rejected.add(s.field)
    }
    for (const s of rest) {
      const accepted = await patchBody({ [s.field]: s.value })
      if (!accepted) rejected.add(s.field)
    }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      return rateLimitAbort()
    }
    throw err
  }

  return { transient: false, rejected }
}
