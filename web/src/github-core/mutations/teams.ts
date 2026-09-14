import type { GitHubClient } from "../client"
import { type GitHubTeam } from "../types"
import {
  STAFF_TEAM_PRIVACY,
  STUDENT_TEAM_PRIVACY,
  type TeamPrivacy,
} from "../types"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import { getClassroomJson } from "../configRepoReads"
import { liveTeamId } from "../queries/teamReads"
import type { StaffRole } from "@/types/classroom"
import { STAFF_ROLES } from "@/types/classroom"
import { createTeam, type TeamNotificationSetting } from "../teamWrites"
import { exemptStaffTeams } from "../rulesets"
import { CONFIG_REPO } from "@/util/configRepo"
import { isCanonicalTeamShortName } from "@/util/shortName"
import { classroomTeamSlug, type ClassroomTeamRole } from "@/util/teamSlug"
import {
  describeLocalizedMessage,
  type LocalizedMessage,
} from "@/types/localizedMessage"

// Minimal team identity persisted in classroom.json. The slug is authoritative
// for team ops (GitHub may slugify a name differently on collision); the id is
// the immutable handle.
export type ClassroomTeamRef = {
  id: number
  slug: string
}

// classroom.json is config-repo-write authored and parsed without schema
// validation, so a team ref read from it is untrusted input to a destructive
// DELETE. A ref is safe to delete only when it (a) names a slug in the
// `classroom50-` namespace this app owns — so a drifted ref can't steer a delete
// into an unrelated org team — and (b) carries a positive integer id, confirmed
// against the live team before deleting so a reused slug isn't clobbered blind.
export function isDeletableClassroomTeamRef(
  team: { id?: unknown; slug?: unknown } | undefined | null,
): team is ClassroomTeamRef {
  return (
    typeof team?.slug === "string" &&
    team.slug.startsWith(`${CONFIG_REPO}-`) &&
    Number.isInteger(team.id) &&
    (team.id as number) > 0
  )
}

// The stricter gate for a classroom's own `teams.<role>` ref: it must name the
// team this app creates for that classroom and role, not merely a
// `classroom50-` team. Staff refs are head-TA writable and drive an owner-run
// bypass revoke plus delete, so a ref pointed at another classroom's staff team
// (which would pass the namespace check and the live-id check) is refused.
// Mirrors the CLI's configrepo.IsCanonicalStaffTeamRef.
export function isOwnedClassroomTeamRef(
  classroom: string,
  role: ClassroomTeamRole,
  team: { id?: unknown; slug?: unknown } | undefined | null,
): team is ClassroomTeamRef {
  return (
    isDeletableClassroomTeamRef(team) &&
    team.slug === classroomTeamSlug(classroom, role)
  )
}

// A classroom's deletable team refs (student plus staff), each gated by
// isOwnedClassroomTeamRef for its role.
export function ownedClassroomTeamRefs(
  classroom: string,
  refs: {
    team?: { id?: unknown; slug?: unknown } | null
    teams?: Partial<
      Record<StaffRole, { id?: unknown; slug?: unknown } | null | undefined>
    > | null
  },
): ClassroomTeamRef[] {
  const out: ClassroomTeamRef[] = []
  if (isOwnedClassroomTeamRef(classroom, "student", refs.team))
    out.push(refs.team)
  for (const role of STAFF_ROLES) {
    const ref = refs.teams?.[role]
    if (isOwnedClassroomTeamRef(classroom, role, ref)) out.push(ref)
  }
  return out
}

// Create (or adopt) a team by exact name at the given privacy. Idempotent:
// adopts a same-named team on 422, reconciling privacy and notification
// setting. `created: false` means it pre-existed and must NOT be deleted on a
// create-failure rollback. The shared core the student and staff teams build on.
async function ensureTeamByName(
  client: GitHubClient,
  org: string,
  name: string,
  notify: TeamNotificationSetting,
  privacy: TeamPrivacy,
  guard: AdoptGuard,
): Promise<ClassroomTeamRef & { created: boolean }> {
  try {
    const created = await createTeam(client, {
      org,
      name,
      privacy,
      notification_setting: notify,
    })
    return { id: created.id, slug: created.slug, created: true }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const adopted = await adoptTeamByName(
        client,
        org,
        name,
        notify,
        privacy,
        guard,
      )
      return { ...adopted, created: false }
    }
    throw err
  }
}

// Decides whether an existing team at a canonical slug may be adopted. A slug
// proves nothing: any org member can create a team there, and classroom
// `<short>-<role>`'s student team sits at `<short>`'s `<role>` slug. So a staff
// team must not be a sibling classroom's student team, and must hold the
// config-repo grant only an owner-run flow gives (or match the id recorded when
// the grant step failed). A student team is always the classroom's own.
// Mirrors the CLI's adoptGuard.
type AdoptGuard =
  | { kind: "student" }
  | { kind: "staff"; classroom: string; role: StaffRole; recordedId?: number }

async function teamHasConfigRepoAccess(
  client: GitHubClient,
  org: string,
  slug: string,
): Promise<boolean> {
  try {
    await client.request(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/repos/${encodeURIComponent(org)}/${CONFIG_REPO}`,
    )
    return true
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return false
    throw err
  }
}

// The classroom whose student team sits at `classroom`'s `role` slug (the
// classroom `<classroom>-<role>`), or null. Mirrors the CLI's StudentTeamOwner.
export async function studentTeamOwner(
  client: GitHubClient,
  org: string,
  classroom: string,
  role: StaffRole,
): Promise<string | null> {
  const other = `${classroom}-${role}`
  try {
    await getClassroomJson(client, { org, classroom: other })
    return other
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return null
    throw err
  }
}

// Thrown when a team at a staff slug is not this classroom's, so nothing adopts
// or reshapes it. `studentOf` is set when it is a sibling classroom's student
// team; otherwise it lacks the config-repo grant. A dedicated type lets the
// reconcile latch it as permanent rather than retry it.
export class UnclaimedTeamError extends Error {
  org: string
  slug: string
  role: StaffRole
  studentOf: string | null
  readonly localized: LocalizedMessage
  constructor(args: {
    org: string
    slug: string
    role: StaffRole
    studentOf?: string | null
  }) {
    const studentOf = args.studentOf ?? null
    const localized: LocalizedMessage = studentOf
      ? {
          key: "staffTeams.unclaimed.studentOf",
          params: { slug: args.slug, classroom: studentOf, role: args.role },
        }
      : {
          key: "staffTeams.unclaimed.staff",
          params: {
            slug: args.slug,
            url: `https://github.com/orgs/${args.org}/teams/${args.slug}`,
          },
        }
    super(describeLocalizedMessage(localized))
    this.name = "UnclaimedTeamError"
    this.org = args.org
    this.slug = args.slug
    this.role = args.role
    this.studentOf = studentOf
    this.localized = localized
  }
}

// Adopt an existing same-named team: read its { id, slug }, confirm it is ours
// (see AdoptGuard), then reconcile drift. Names are slug-safe (guarded
// upstream), so the name doubles as the lookup slug.
async function adoptTeamByName(
  client: GitHubClient,
  org: string,
  name: string,
  notify: TeamNotificationSetting,
  privacy: TeamPrivacy,
  guard: AdoptGuard,
): Promise<ClassroomTeamRef> {
  const existing = await client.request<GitHubTeam>(
    `/orgs/${org}/teams/${name}`,
  )
  // Before any write: a team that isn't ours must not be reshaped.
  if (guard.kind === "staff") {
    const owner = await studentTeamOwner(
      client,
      org,
      guard.classroom,
      guard.role,
    )
    if (owner) {
      throw new UnclaimedTeamError({
        org,
        slug: existing.slug,
        role: guard.role,
        studentOf: owner,
      })
    }
    const granted = await teamHasConfigRepoAccess(client, org, existing.slug)
    const recorded =
      guard.recordedId !== undefined && guard.recordedId === existing.id
    if (!granted && !recorded) {
      throw new UnclaimedTeamError({
        org,
        slug: existing.slug,
        role: guard.role,
      })
    }
  } else {
    // A student team must never hold config-repo access (students could read
    // classroom.json); an older release may have granted it. Idempotent.
    await removeRepositoryFromTeam(client, {
      org,
      teamSlug: existing.slug,
      owner: org,
      repo: CONFIG_REPO,
    })
  }
  const patch: {
    privacy?: TeamPrivacy
    notification_setting?: TeamNotificationSetting
  } = {}
  if (existing.privacy !== privacy) patch.privacy = privacy
  // GitHub returns notification_setting only to org members, so an absent value
  // is "unknown, not read" — skip it rather than PATCH every reconcile. A
  // concrete value that differs is reconciled on purpose (a student team left
  // enabled gets disabled — #335).
  if (
    existing.notification_setting !== undefined &&
    existing.notification_setting !== notify
  )
    patch.notification_setting = notify
  if (Object.keys(patch).length > 0) {
    await client.request(`/orgs/${org}/teams/${existing.slug}`, {
      method: "PATCH",
      body: patch,
    })
  }
  return { id: existing.id, slug: existing.slug }
}

// Guard a classroom short-name before deriving any team name from it: a
// trailing/consecutive-hyphen short-name slugifies to something other than
// `classroom50-<short>[-<role>]`, breaking every op that re-derives the slug.
function assertCanonicalTeamShortName(classroom: string): void {
  if (!isCanonicalTeamShortName(classroom)) {
    throw new Error(
      `Classroom slug "${classroom}" can't back a GitHub team — remove consecutive or trailing hyphens (GitHub would rewrite the team slug, breaking membership and template grants).`,
    )
  }
}

// Create (or adopt) the per-classroom STUDENTS team and return its { id, slug }
// for classroom.json. Grants rostered students read on private org templates.
export async function ensureClassroomTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<ClassroomTeamRef & { created: boolean }> {
  assertCanonicalTeamShortName(classroom)
  return ensureTeamByName(
    client,
    org,
    classroomTeamSlug(classroom),
    "notifications_disabled",
    STUDENT_TEAM_PRIVACY,
    { kind: "student" },
  )
}

// The per-classroom staff team refs persisted under classroom.json `teams`.
// `teacher` is canonical; `hta` (head TA) is the middle tier granted
// config-repo write but never org-owner.
export type StaffTeamRefs = {
  teacher?: ClassroomTeamRef
  hta?: ClassroomTeamRef
  ta?: ClassroomTeamRef
}

// The id classroom.json records for the role's canonical team, or undefined
// when absent or naming another team.
function recordedStaffTeamId(
  classroom: string,
  role: StaffRole,
  recorded: StaffTeamRefs | undefined,
): number | undefined {
  const ref = recorded?.[role]
  return isOwnedClassroomTeamRef(classroom, role, ref) ? ref.id : undefined
}

// Config-repo permission per staff role: teacher/hta author assignments
// (write), a plain TA is read-only. Mirrors the CLI's
// configrepo.ConfigRepoPermission. A role absent here gets no config-repo grant.
const CONFIG_REPO_PERMISSION: Partial<Record<StaffRole, "pull" | "push">> = {
  teacher: "push",
  hta: "push",
  ta: "pull",
}

// Create (or adopt) the per-classroom STAFF team for `role`, a `closed` team
// named `classroom50-<classroom>-<role>`. Idempotent — safe as a preflight
// before any role op. A newly minted team is exempted from the feedback-base
// lock so its members can merge feedback PRs (best-effort). `recorded` is the
// current `teams` block, consulted only to re-adopt a team whose grant was
// lost; the role flows omit it because the per-visit reconcile has already
// healed or refused such a team before a teacher can act on the role.
export async function ensureClassroomRoleTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
  role: StaffRole,
  recorded?: StaffTeamRefs,
): Promise<ClassroomTeamRef & { created: boolean }> {
  const team = await ensureRoleTeamRaw(client, org, classroom, role, recorded)
  await exemptStaffTeams(client, org, [team.id])
  return team
}

// ensureClassroomRoleTeam without the ruleset hook, so ensureStaffTeams can
// exempt all three teams in one ruleset write.
async function ensureRoleTeamRaw(
  client: GitHubClient,
  org: string,
  classroom: string,
  role: StaffRole,
  recorded: StaffTeamRefs | undefined,
): Promise<ClassroomTeamRef & { created: boolean }> {
  assertCanonicalTeamShortName(classroom)
  // Staff enable notifications so @mentions reach TAs/teachers (#335); the
  // student team stays disabled (see TeamNotificationSetting).
  return ensureTeamByName(
    client,
    org,
    classroomTeamSlug(classroom, role),
    "notifications_enabled",
    STAFF_TEAM_PRIVACY,
    {
      kind: "staff",
      classroom,
      role,
      recordedId: recordedStaffTeamId(classroom, role, recorded),
    },
  )
}

// Grant a team `push` (write) on the org's `classroom50` config repo, so its
// members can author assignments (commit assignments.json etc.). Idempotent.
export async function grantTeamConfigRepoWrite(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<void> {
  await addRepositoryToTeam(client, {
    org,
    teamSlug,
    owner: org,
    repo: CONFIG_REPO,
    permission: "push",
  })
}

// Set a staff team's config-repo permission to the role's mapped level —
// `push` for teacher/hta, `pull` for ta. Unlike a bare
// grantTeamConfigRepoWrite this is role-aware and, because addRepositoryToTeam
// PUTs unconditionally, it DOWNGRADES an existing stronger grant (a TA team
// that held `push` drops to `pull`) — the behavior the TA read-only demotion
// depends on. A role with no mapped permission is a no-op. Route every
// config-repo grant site through this so a role can't silently keep write.
export async function grantTeamConfigRepoAccess(
  client: GitHubClient,
  org: string,
  teamSlug: string,
  role: StaffRole,
): Promise<void> {
  const permission = CONFIG_REPO_PERMISSION[role]
  if (!permission) return
  await addRepositoryToTeam(client, {
    org,
    teamSlug,
    owner: org,
    repo: CONFIG_REPO,
    permission,
  })
}

// Ensure every staff team exists, returning their refs for classroom.json.
// Idempotent — used at create AND as a preflight, so a classroom missing a
// staff team self-heals on next touch. `created` lists the roles this call
// newly created (for create-failure rollback).
//
// This does NOT grant config-repo access — callers must invoke
// grantStaffTeamsConfigRepoAccess separately, AFTER dropping the auto-added
// creator from the non-teacher teams. GitHub auto-adds the team creator as a
// maintainer, and removing a member from a team that HOLDS repo access emails
// them a "removed from team" alert; doing the grant only once the owner is gone
// keeps that drop silent (the notification_setting toggle can't — it governs
// only @mentions). `recorded` is the current `teams` block (absent at create).
// A role whose slug is held by a team that isn't ours is left out of `teams`
// and reported in `unclaimed`: create fails on it, the reconcile works around
// it.
export async function ensureStaffTeams(
  client: GitHubClient,
  org: string,
  classroom: string,
  recorded?: StaffTeamRefs,
): Promise<{
  teams: StaffTeamRefs
  created: StaffRole[]
  unclaimed: UnclaimedTeamError[]
}> {
  const teams: StaffTeamRefs = {}
  const created: StaffRole[] = []
  const unclaimed: UnclaimedTeamError[] = []
  for (const role of STAFF_ROLES) {
    let team: ClassroomTeamRef & { created: boolean }
    try {
      team = await ensureRoleTeamRaw(client, org, classroom, role, recorded)
    } catch (err) {
      if (err instanceof UnclaimedTeamError) {
        unclaimed.push(err)
        continue
      }
      throw err
    }
    teams[role] = { id: team.id, slug: team.slug }
    if (team.created) created.push(role)
  }
  // One idempotent ruleset pass for all three teams, created or adopted: this
  // is how a classroom from an older release gets its staff onto the bypass
  // list the first time a teacher opens it (the reconcile calls this).
  await exemptStaffTeams(
    client,
    org,
    STAFF_ROLES.flatMap((role) => teams[role]?.id ?? []),
  )
  return { teams, created, unclaimed }
}

// Grant each staff team its role's config-repo access (teacher/hta write, ta
// read-only). Permission-aware — a TA team that still holds write is downgraded
// to read on re-affirm. Split from ensureStaffTeams so callers run it AFTER the
// creator drop (see ensureStaffTeams). Safe at create AND as a reconcile
// preflight.
export async function grantStaffTeamsConfigRepoAccess(
  client: GitHubClient,
  org: string,
  teams: StaffTeamRefs,
): Promise<void> {
  for (const role of STAFF_ROLES) {
    const slug = teams[role]?.slug
    if (!slug) continue
    await grantTeamConfigRepoAccess(client, org, slug, role)
  }
}

// Thrown by deleteClassroomTeam when the live team's id no longer matches the
// id recorded in classroom.json (a slug reused for a different team). A
// dedicated type lets callers and telemetry tell this deliberate safety refusal
// — which a re-run repeats forever — from a transient, worth-retrying failure.
export class TeamIdMismatchError extends Error {
  slug: string
  recordedId: number
  liveId: number
  constructor(args: {
    org: string
    slug: string
    recordedId: number
    liveId: number
  }) {
    super(
      `Team "${args.slug}" in ${args.org} now has id ${args.liveId}, not the recorded ${args.recordedId} — refusing to delete a team that isn't the one this classroom created; remove it by hand if intended.`,
    )
    this.name = "TeamIdMismatchError"
    this.slug = args.slug
    this.recordedId = args.recordedId
    this.liveId = args.liveId
  }
}

// Delete the per-classroom team by its persisted slug. Fail-closed against an
// untrusted/drifted classroom.json ref: refuses any ref outside the
// `classroom50-` namespace or without a positive id (see
// isDeletableClassroomTeamRef). As further defense against a reused slug, the
// live team's id is confirmed against the persisted id. 404 = already gone.
export async function deleteClassroomTeam(
  client: GitHubClient,
  org: string,
  team: ClassroomTeamRef | undefined | null,
): Promise<void> {
  if (!team?.slug) return
  // Authoritative backstop for every caller: never delete a ref this app
  // doesn't own. A non-conforming ref is a no-op.
  if (!isDeletableClassroomTeamRef(team)) return

  const liveId = await liveTeamId(client, org, team.slug)
  if (liveId === null) return
  if (liveId !== team.id) {
    throw new TeamIdMismatchError({
      org,
      slug: team.slug,
      recordedId: team.id,
      liveId,
    })
  }

  await tolerateGitHubError(
    () =>
      client.request(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
        {
          method: "DELETE",
        },
      ),
    undefined,
  )
}

export function addRepositoryToTeam(
  client: GitHubClient,
  input: {
    org: string
    teamSlug: string
    owner: string
    repo: string
    permission: "pull" | "triage" | "push" | "maintain" | "admin"
  },
) {
  const { org, teamSlug, owner, repo, permission } = input

  return client.request(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
      teamSlug,
    )}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      method: "PUT",
      body: { permission },
    },
  )
}

// Remove a team's access to a repo. 404 (never granted, or repo/team gone) is
// success, so revoking is idempotent. Used when LOCKING a private-template
// assignment (the classroom STUDENT team's read on the template is dropped so
// no new student can generate from it; staff teams are left untouched) and when
// adopting a student team, to strip a config-repo grant an older release gave it.
export async function removeRepositoryFromTeam(
  client: GitHubClient,
  input: {
    org: string
    teamSlug: string
    owner: string
    repo: string
  },
): Promise<void> {
  const { org, teamSlug, owner, repo } = input

  await tolerateGitHubError(
    () =>
      client.request(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
          teamSlug,
        )}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: "DELETE" },
      ),
    undefined,
  )
}

export function addUserToTeam(
  client: GitHubClient,
  input: {
    org: string
    teamSlug: string
    username: string
    role?: "member" | "maintainer"
  },
) {
  const { org, teamSlug, username, role } = input

  return client.request(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
      teamSlug,
    )}/memberships/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      body: { role },
    },
  )
}

// Remove a user from a team. 404 = not a member / team gone (success), so it's
// idempotent. Org membership is untouched — only the team grant (and the
// template read it confers) is dropped.
export async function removeUserFromTeam(
  client: GitHubClient,
  input: {
    org: string
    teamSlug: string
    username: string
  },
): Promise<void> {
  const { org, teamSlug, username } = input

  await tolerateGitHubError(
    () =>
      client.request(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
          teamSlug,
        )}/memberships/${encodeURIComponent(username)}`,
        { method: "DELETE" },
      ),
    undefined,
  )
}
