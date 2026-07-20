import type { GitHubClient } from "../client"
import { type GitHubTeam } from "../types"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import type { StaffRole } from "@/types/classroom"
import { STAFF_ROLES } from "@/types/classroom"
import { createTeam, type TeamNotificationSetting } from "../teamWrites"
import { CONFIG_REPO } from "@/util/configRepo"
import { classroomTeamSlug } from "@/util/teamSlug"

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

// A short-name with consecutive/trailing hyphens slugifies to something other
// than `classroom50-<short>`, breaking team ops that re-derive the slug.
function isCanonicalTeamShortName(shortName: string): boolean {
  return !shortName.endsWith("-") && !shortName.includes("--")
}

// Create (or adopt) a `secret` team by exact name. Idempotent: adopts a
// same-named team on 422, reconciling privacy and notification setting.
// `created: false` means it pre-existed and must NOT be deleted on a
// create-failure rollback. The shared core the student and staff teams build on.
async function ensureSecretTeamByName(
  client: GitHubClient,
  org: string,
  name: string,
  notify: TeamNotificationSetting,
): Promise<ClassroomTeamRef & { created: boolean }> {
  try {
    const created = await createTeam(client, {
      org,
      name,
      privacy: "secret",
      notification_setting: notify,
    })
    return { id: created.id, slug: created.slug, created: true }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const adopted = await adoptSecretTeamByName(client, org, name, notify)
      return { ...adopted, created: false }
    }
    throw err
  }
}

// Adopt an existing same-named team: read its { id, slug } and reconcile drift
// (privacy, notification setting). Names are slug-safe (guarded upstream), so
// the name doubles as the lookup slug.
async function adoptSecretTeamByName(
  client: GitHubClient,
  org: string,
  name: string,
  notify: TeamNotificationSetting,
): Promise<ClassroomTeamRef> {
  const existing = await client.request<GitHubTeam>(
    `/orgs/${org}/teams/${name}`,
  )
  const patch: {
    privacy?: "secret"
    notification_setting?: TeamNotificationSetting
  } = {}
  if (existing.privacy !== "secret") patch.privacy = "secret"
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
  return ensureSecretTeamByName(
    client,
    org,
    classroomTeamSlug(classroom),
    "notifications_disabled",
  )
}

// The per-classroom staff team refs persisted under classroom.json `teams`.
// `teacher` is canonical; `instructor` is the legacy alias retained for
// backward-compatible reads during the rename migration; `hta` (head TA) is the
// middle tier granted config-repo write but never org-owner.
export type StaffTeamRefs = {
  teacher?: ClassroomTeamRef
  instructor?: ClassroomTeamRef
  hta?: ClassroomTeamRef
  ta?: ClassroomTeamRef
}

// Config-repo permission per staff role: teacher/instructor/hta author
// assignments (write), a plain TA is read-only. Mirrors the CLI's
// configrepo.ConfigRepoPermission. A role absent here gets no config-repo grant.
const CONFIG_REPO_PERMISSION: Partial<Record<StaffRole, "pull" | "push">> = {
  teacher: "push",
  instructor: "push",
  hta: "push",
  ta: "pull",
}

// Create (or adopt) the per-classroom STAFF team for `role`, a `secret` team
// named `classroom50-<classroom>-<role>`. Idempotent — safe as a preflight
// before any role op.
export async function ensureClassroomRoleTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
  role: StaffRole,
): Promise<ClassroomTeamRef & { created: boolean }> {
  assertCanonicalTeamShortName(classroom)
  // Staff enable notifications (student team stays disabled); see
  // TeamNotificationSetting.
  return ensureSecretTeamByName(
    client,
    org,
    classroomTeamSlug(classroom, role),
    "notifications_enabled",
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
// `push` for teacher/instructor/hta, `pull` for ta. Unlike a bare
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

// Ensure every staff team exists and holds its role's config-repo access
// (teacher/hta write, ta read-only), returning their refs for classroom.json.
// Idempotent — used at create AND as a preflight, so a classroom missing a
// staff team self-heals on next touch, and a TA team that still holds write is
// downgraded to read on re-affirm. `created` lists the roles this call newly
// created (for create-failure rollback).
export async function ensureStaffTeams(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<{ teams: StaffTeamRefs; created: StaffRole[] }> {
  const teams: StaffTeamRefs = {}
  const created: StaffRole[] = []
  for (const role of STAFF_ROLES) {
    const team = await ensureClassroomRoleTeam(client, org, classroom, role)
    teams[role] = { id: team.id, slug: team.slug }
    if (team.created) created.push(role)
    await grantTeamConfigRepoAccess(client, org, team.slug, role)
  }
  return { teams, created }
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

  try {
    const live = await client.request<{ id: number }>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
    )
    if (live.id !== team.id) {
      throw new TeamIdMismatchError({
        org,
        slug: team.slug,
        recordedId: team.id,
        liveId: live.id,
      })
    }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return
    }
    throw err
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
