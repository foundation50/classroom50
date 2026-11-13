import type { TFunction } from "i18next"

import { describeWriteFailure } from "@/components/modals/collaboratorHelpers"
import { permissionSatisfies } from "@/domain/assignments/permissions"
import { studentRepoName } from "@/util/studentRepo"
import type { RepoPermission } from "@/types/classroom"

import { runBulkFanOut, type FanOutOutcome, type FanOutResult } from "./fanOut"

// A verified write GitHub silently ignored: the PUT returned 204 but the
// student's effective role didn't land on the target. Reported distinctly from
// a hard error so callers can surface "still <role>" instead of an HTTP status.
export class AccessNotAppliedError extends Error {
  readonly effective: string | undefined
  constructor(effective: string | undefined) {
    super(`access not applied (still ${effective ?? "unchanged"})`)
    this.name = "AccessNotAppliedError"
    this.effective = effective
  }
}

// The shared write-failure reasons plus the one this fan-out adds.
export const describeAccessFailure = (
  reason: unknown,
  t: TFunction,
): string | undefined => {
  if (reason instanceof AccessNotAppliedError) {
    return t("components.modals.repoAccess.notApplied", {
      effective: reason.effective ?? "unknown",
    })
  }
  return describeWriteFailure(reason, t)
}

// A silently-ignored write is marked `notApplied` so callers can tell a
// deterministic miss (a role GitHub won't lower, e.g. an org owner's) from a
// transient failure that a retry could fix. `effective` is the role that stuck.
// On a shared repo `members` names each "login (role)" GitHub kept.
export type NotAppliedOutcome = {
  owner: string
  status: "failed"
  detail?: string
  notApplied: true
  effective?: string
  members?: string[]
}
export type BulkAccessOutcome = FanOutOutcome | NotAppliedOutcome
export type BulkAccessResult = FanOutResult<BulkAccessOutcome>

export const isNotApplied = (
  outcome: BulkAccessOutcome,
): outcome is NotAppliedOutcome => "notApplied" in outcome

// One collaborator role write with a read-back. `effective` is undefined when
// the read-back lagged or 404'd.
export type SetCollaborator = (params: {
  org: string
  repo: string
  username: string
  permission: RepoPermission
  verify: boolean
}) => Promise<{ effective?: { permission?: string; role_name?: string } }>

type RunBulkRepoAccessParams = {
  owners: string[]
  org: string
  classroom: string
  assignment: string
  permission: RepoPermission
  setCollaborator: SetCollaborator
  // How a residual (read-back) role is judged against the requested one:
  //   - false (exact "=="): a residual ABOVE the requested role is the
  //     over-access a downgrade must catch — fail loudly. Use for a lockdown.
  //   - true (">=" floor): a residual at or above the requested role is benign;
  //     only a read-back BELOW it fails. Use when restoring/raising access.
  treatRequestedAsFloor: boolean
  t: TFunction
  // Guards setState-after-unmount and lets an in-flight run stop launching new
  // writes when the caller unmounts mid-fan-out.
  isMounted: () => boolean
  // Called after each owner is processed (success, failure, or deferral) with
  // the running processed count and the owner just handled.
  onProgress: (processed: number, owner: string) => void
}

// One verified collaborator write; throws AccessNotAppliedError when the
// read-back shows GitHub kept a role the request should have changed.
async function setAndVerifyCollaborator(params: {
  setCollaborator: SetCollaborator
  org: string
  repo: string
  username: string
  permission: RepoPermission
  treatRequestedAsFloor: boolean
}): Promise<void> {
  const { setCollaborator, org, repo, username, permission } = params
  const { effective } = await setCollaborator({
    org,
    repo,
    username,
    permission,
    verify: true,
  })
  if (
    effective &&
    !permissionSatisfies(
      effective.permission,
      effective.role_name,
      permission,
      params.treatRequestedAsFloor,
    )
  ) {
    throw new AccessNotAppliedError(effective.role_name || effective.permission)
  }
}

// The shared bounded repo-access fan-out for student-owned repos (set-access,
// individual close/reopen; shared repos go through runBulkGroupRepoAccess
// below). Sets each accepted student's role on their own repo with bounded
// concurrency, verifies the effective role, short-circuits the remainder to
// `deferred` on a secondary rate-limit, and reports per-owner outcomes. The
// permission and the residual-role comparison are the only axes callers vary.
export async function runBulkRepoAccess({
  owners,
  org,
  classroom,
  assignment,
  permission,
  setCollaborator,
  treatRequestedAsFloor,
  t,
  isMounted,
  onProgress,
}: RunBulkRepoAccessParams): Promise<BulkAccessResult> {
  return runBulkFanOut<BulkAccessOutcome>({
    owners,
    isMounted,
    onProgress,
    t,
    perOwner: async (owner) => {
      const repo = studentRepoName(classroom, assignment, owner)
      try {
        await setAndVerifyCollaborator({
          setCollaborator,
          org,
          repo,
          username: owner,
          permission,
          treatRequestedAsFloor,
        })
      } catch (err) {
        // The generic fan-out only knows the shared vocabulary; give the
        // not-applied case its own line before it becomes a plain failure.
        if (err instanceof AccessNotAppliedError) {
          return {
            owner,
            status: "failed",
            detail: describeAccessFailure(err, t),
            notApplied: true,
            effective: err.effective,
          }
        }
        throw err
      }
    },
  })
}

// One shared repo of a group or team assignment, keyed by the row owner. A
// legacy group repo is owned by its founder's login; a team repo by `group-<n>`
// and held through the GitHub team in `teamSlug`, which is undefined while the
// team listing is pending or after it failed (the fan-out fails that repo
// closed rather than treat it as a legacy group).
export type GroupAccessTarget =
  | { kind: "group"; owner: string; repoName: string }
  | { kind: "team"; owner: string; repoName: string; teamSlug?: string }

type RunBulkGroupRepoAccessParams = Omit<
  RunBulkRepoAccessParams,
  "owners" | "classroom" | "assignment"
> & {
  targets: GroupAccessTarget[]
  listCollaborators: (org: string, repo: string) => Promise<{ login: string }[]>
  setTeamPermission: (params: {
    org: string
    teamSlug: string
    repo: string
    permission: RepoPermission
  }) => Promise<unknown>
  // Lowercased logins whose direct collaborator role is left alone in both
  // directions (classroom staff): closing must not strip a TA's write, and
  // reopening must not promote one held at read.
  skipLogins?: ReadonlySet<string>
  // The role to write for one collaborator; defaults to `permission`. Lets a
  // reopen restore the legacy founder's admin instead of a flat push.
  permissionFor?: (target: GroupAccessTarget, login: string) => RepoPermission
}

// The shared-repo sibling of runBulkRepoAccess: one unit of work per group repo.
// Access to a shared repo comes from two places, so both are set: the group's
// team (team mode; the team PUT can't be silently ignored, so it isn't read
// back) and every direct collaborator (the founder in both flavors, plus each
// member in a legacy group). A group whose only misses are kept roles reports
// `notApplied` with the members GitHub kept; any other failure fails the group
// so a retry covers it whole.
export async function runBulkGroupRepoAccess({
  targets,
  org,
  permission,
  setCollaborator,
  listCollaborators,
  setTeamPermission,
  skipLogins,
  permissionFor,
  treatRequestedAsFloor,
  t,
  isMounted,
  onProgress,
}: RunBulkGroupRepoAccessParams): Promise<BulkAccessResult> {
  const byOwner = new Map(targets.map((target) => [target.owner, target]))
  return runBulkFanOut<BulkAccessOutcome>({
    owners: targets.map((target) => target.owner),
    isMounted,
    onProgress,
    t,
    perOwner: async (owner) => {
      const target = byOwner.get(owner)
      if (!target) throw new Error(`no group repo target for ${owner}`)
      if (target.kind === "team") {
        // Without the team the repo cannot be made read-only, and lowering the
        // founder alone would read as success while every member keeps write.
        if (!target.teamSlug) {
          return {
            owner,
            status: "failed",
            detail: t("components.modals.repoAccess.teamMissing"),
          }
        }
        await setTeamPermission({
          org,
          teamSlug: target.teamSlug,
          repo: target.repoName,
          permission,
        })
      }
      const members = await listCollaborators(org, target.repoName)
      const kept: string[] = []
      // Sequential: a group is a handful of logins, and the per-group fan-out
      // already runs several groups at once.
      for (const member of members) {
        if (skipLogins?.has(member.login.toLowerCase())) continue
        try {
          await setAndVerifyCollaborator({
            setCollaborator,
            org,
            repo: target.repoName,
            username: member.login,
            permission: permissionFor?.(target, member.login) ?? permission,
            treatRequestedAsFloor,
          })
        } catch (err) {
          if (err instanceof AccessNotAppliedError) {
            kept.push(`${member.login} (${err.effective ?? "unknown"})`)
            continue
          }
          throw err
        }
      }
      if (kept.length > 0) {
        return {
          owner,
          status: "failed",
          detail: t("components.modals.repoAccess.notAppliedMembers", {
            members: kept.join(", "),
          }),
          notApplied: true,
          members: kept,
        }
      }
    },
  })
}
