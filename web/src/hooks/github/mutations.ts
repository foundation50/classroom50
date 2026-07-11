import type { GitHubClient } from "./client"
import { createGitHubClient } from "./client"
import {
  type GitHubCreateTree,
  type GitHubCreateCommit,
  type GitHubMoveBranch,
  type GitHubTeam,
  type GitHubRepo,
  type GitHubOrgMembership,
  type GitHubBlob,
} from "./types"
import { GitHubAPIError } from "./errors"
import sodium from "libsodium-wrappers"
import { getBranchRef, getClassroomJson, getCommit } from "@/api/github/queries"
import type { CreateClassroomInput } from "@/api/mutations/classrooms"
import type { StaffRole } from "@/types/classroom"
import { isClassroomArchived, STAFF_ROLES } from "@/types/classroom"
import { STUDENT_CSV_FIELDS } from "@/api/mutations/students"
import { getRepo } from "./queries"
import { CONFIG_REPO, checkPages, repairOrgDefaults } from "./orgChecks"
import { prefixCommit } from "@/util/commit"
import { repairRulesets } from "./rulesets"
import { buildSkeletonFiles, type SkeletonFile } from "@/skeleton/skeleton"
import { bytesToHex } from "@/util/hex"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"

const logWorkflows = logger.scope("github:workflows")
const logSetup = logger.scope(LOG_SCOPE_GITHUB_SETUP)

const ASSIGNMENTS_TEMPLATE = {
  schema: "classroom50/assignments/v1",
  assignments: [],
}
const createClassroomMetadata = (
  org: string,
  classroom: string,
  name: string | undefined,
  term: string,
  team?: ClassroomTeamRef,
  secret?: string,
  teams?: StaffTeamRefs,
) => ({
  schema: "classroom50/classroom/v1",
  // Fall back to the slug when no display name was supplied.
  name: name || classroom,
  short_name: classroom,
  term,
  org,
  // Written only when a team was provisioned (matches the CLI's `omitempty`).
  // Grants rostered students read on private org templates.
  ...(team ? { team } : {}),
  // Per-classroom staff teams (instructor/ta) backing in-app roles. Written only
  // when provisioned.
  ...(teams && (teams.instructor || teams.ta) ? { teams } : {}),
  // Written only when the teacher opted into protected resources (CLI
  // `omitempty`). When present, Pages resources publish under
  // `<classroom>/<secret>/...`.
  ...(secret ? { secret } : {}),
})

// Seed header for a new classroom's empty roster.csv. Derived from the single
// source of truth (STUDENT_CSV_FIELDS) so it can't drift; computed lazily (not
// at module-eval) to dodge the students.ts <-> mutations.ts circular-import TDZ.
// The parser is header-based, so an older roster still parses.
const studentsCsvHeader = () => STUDENT_CSV_FIELDS.join(",") + "\n"
const createClassroomBody = (
  base_tree: string,
  org: string,
  classroom: string,
  name: string | undefined,
  term: string,
  team?: ClassroomTeamRef,
  secret?: string,
  teams?: StaffTeamRefs,
) => {
  const mode = "100644"
  const type = "blob"

  return {
    base_tree,
    tree: [
      {
        path: `${classroom}/assignments.json`,
        mode,
        type,
        content: JSON.stringify(ASSIGNMENTS_TEMPLATE, null, 2),
      },
      {
        path: `${classroom}/roster.csv`,
        mode,
        type,
        content: studentsCsvHeader(),
      },
      {
        path: `${classroom}/scores.json`,
        mode,
        type,
        content: JSON.stringify(
          {
            schema: "classroom50/scores/v1",
            assignments: {},
          },
          null,
          2,
        ),
      },
      {
        path: `${classroom}/classroom.json`,
        mode,
        type,
        content: JSON.stringify(
          createClassroomMetadata(
            org,
            classroom,
            name,
            term,
            team,
            secret,
            teams,
          ),
          null,
          2,
        ),
      },
    ],
  }
}

export function createTree(
  client: GitHubClient,
  input: CreateClassroomInput & {
    base_tree: string
    term: string
    team?: ClassroomTeamRef
    teams?: StaffTeamRefs
  },
) {
  const { base_tree, org, classroom, name, term, team, teams } = input
  return client.request<GitHubCreateTree>(
    `/repos/${org}/classroom50/git/trees`,
    {
      method: "POST",
      body: createClassroomBody(
        base_tree,
        org,
        classroom,
        name,
        term,
        team,
        input.secret,
        teams,
      ),
    },
  )
}

export function createTreeRepo(
  client: GitHubClient,
  input: {
    base_tree: string
    org: string
    repo: string
    tree: { path: string; mode: string; type: string; content: string }[]
  },
) {
  const { base_tree, org, repo, tree } = input

  return client.request<GitHubTree>(`/repos/${org}/${repo}/git/trees`, {
    method: "POST",
    body: {
      base_tree,
      tree,
    },
  })
}

type GitHubTree = {
  sha: string
}
export function createTreeForAssignment(params: {
  client: GitHubClient
  owner: string
  repo: string
  baseTreeSha: string
  metadataYaml: string
  autogradeYaml: string
}) {
  const { client, owner, repo, baseTreeSha, metadataYaml, autogradeYaml } =
    params

  return client.request<GitHubTree>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTreeSha,
      tree: [
        {
          path: ".classroom50.yaml",
          mode: "100644",
          type: "blob",
          content: metadataYaml,
        },
        {
          path: ".github/workflows/autograde.yaml",
          mode: "100644",
          type: "blob",
          content: autogradeYaml,
        },
      ],
    },
  })
}

export function createCommit(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    parents: [string]
    tree_sha: string
    message?: string
  },
) {
  const { classroom, tree_sha, org, parents, message } = input
  return client.request<GitHubCreateCommit>(
    `/repos/${org}/classroom50/git/commits`,
    {
      method: "POST",
      body: {
        message:
          message ||
          prefixCommit(`Create init files for new classroom: ${classroom}`),
        tree: tree_sha,
        parents,
      },
    },
  )
}

export function createCommitRepo(
  client: GitHubClient,
  input: {
    org: string
    repo: string
    parents: [string]
    tree: string
    message: string
  },
) {
  const { org, repo, parents, tree, message } = input

  return client.request<GitHubCreateCommit>(
    `/repos/${org}/${repo}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree,
        parents,
      },
    },
  )
}

export function createCommitForAssignment(params: {
  client: GitHubClient
  owner: string
  repo: string
  message: string
  treeSha: string
  parentSha: string
}) {
  const { client, owner, repo, message, treeSha, parentSha } = params

  return client.request<GitHubCreateCommit>(
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree: treeSha,
        parents: [parentSha],
      },
    },
  )
}

export function updateRef(client: GitHubClient, org: string, sha: string) {
  return client.request<GitHubMoveBranch>(
    `/repos/${org}/classroom50/git/refs/heads/main`,
    {
      method: "PATCH",
      body: {
        sha,
        force: false,
      },
    },
  )
}

type GitHubRef = {
  ref: string
  object: {
    sha: string
    type: string
    url: string
  }
}
export function updateRefForRepo(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
  commitSha: string
}) {
  const { client, owner, repo, branch, commitSha } = params

  return client.request<GitHubRef>(
    `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: "PATCH",
      body: {
        sha: commitSha,
        force: false,
      },
    },
  )
}

export {
  createClassroomFiles,
  createClassroomFilesWithConflictRetry,
} from "@/api/mutations/classrooms"

// One entry in a git tree write. GitHub accepts either inline `content` or a
// `sha` (existing blob, or `null` to delete the path).
export type GitTreeFileMode = "100644" | "100755" | "120000"
export type GitTreeEntry = {
  path: string
  mode: GitTreeFileMode
  type: "blob"
} & ({ content: string } | { sha: string | null })
export type CreateGitTreeInput = {
  org: string
  base_tree: string
  tree: GitTreeEntry[]
}
export function createGitTree(client: GitHubClient, input: CreateGitTreeInput) {
  const { org, base_tree, tree } = input

  return client.request<GitHubCreateTree>(
    `/repos/${org}/classroom50/git/trees`,
    {
      method: "POST",
      body: {
        base_tree,
        tree,
      },
    },
  )
}

export type CreateGitCommitInput = {
  org: string
  message: string
  tree_sha: string
  parents: [string]
}
export function createGitCommit(
  client: GitHubClient,
  input: CreateGitCommitInput,
) {
  const { org, message, tree_sha, parents } = input

  return client.request<GitHubCreateCommit>(
    `/repos/${org}/classroom50/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree: tree_sha,
        parents,
      },
    },
  )
}

export {
  createAssignment,
  createAssignmentWithConflictRetry,
} from "@/api/mutations/assignments"

export type CreateTeamInput = {
  org: string
  name: string
  description?: string
  privacy?: "secret" | "closed"
  maintainers?: string[]
  repo_names?: string[]
}
export function createTeam(client: GitHubClient, input: CreateTeamInput) {
  const { org, ...body } = input

  return client.request<GitHubTeam>(`/orgs/${org}/teams`, {
    method: "POST",
    body: {
      privacy: "closed",
      notification_setting: "notifications_disabled",
      ...body,
    },
  })
}

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
    team.slug.startsWith("classroom50-") &&
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
// same-named team on 422 and reconciles privacy to `secret`. `created: false`
// means it pre-existed and must NOT be deleted on a create-failure rollback.
// The shared core the students team and staff teams build on.
async function ensureSecretTeamByName(
  client: GitHubClient,
  org: string,
  name: string,
): Promise<ClassroomTeamRef & { created: boolean }> {
  try {
    const created = await createTeam(client, { org, name, privacy: "secret" })
    return { id: created.id, slug: created.slug, created: true }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const adopted = await adoptSecretTeamByName(client, org, name)
      return { ...adopted, created: false }
    }
    throw err
  }
}

// Adopt an existing same-named team: read its { id, slug } and reconcile privacy
// to `secret`. Our names are already slug-safe (guarded upstream), so the name
// doubles as the lookup slug.
async function adoptSecretTeamByName(
  client: GitHubClient,
  org: string,
  name: string,
): Promise<ClassroomTeamRef> {
  const existing = await client.request<GitHubTeam>(
    `/orgs/${org}/teams/${name}`,
  )
  if (existing.privacy !== "secret") {
    await client.request(`/orgs/${org}/teams/${existing.slug}`, {
      method: "PATCH",
      body: { privacy: "secret" },
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
  return ensureSecretTeamByName(client, org, `classroom50-${classroom}`)
}

// The per-classroom staff team refs persisted under classroom.json `teams`.
export type StaffTeamRefs = {
  instructor?: ClassroomTeamRef
  ta?: ClassroomTeamRef
}

// The team name (== slug, given the canonical-short-name guard) for a staff
// role: `classroom50-<classroom>-<role>`.
export function staffTeamName(classroom: string, role: StaffRole): string {
  return `classroom50-${classroom}-${role}`
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
  return ensureSecretTeamByName(client, org, staffTeamName(classroom, role))
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

// Ensure BOTH staff teams exist and are granted config-repo write, returning
// their refs for classroom.json. Idempotent — used at create AND as a preflight,
// so a classroom missing a staff team self-heals on next touch. `created` lists
// the roles this call newly created (for create-failure rollback).
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
    await grantTeamConfigRepoWrite(client, org, team.slug)
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

  try {
    await client.request(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
      {
        method: "DELETE",
      },
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return
    }
    throw err
  }
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

  try {
    await client.request(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
        teamSlug,
      )}/memberships/${encodeURIComponent(username)}`,
      { method: "DELETE" },
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return
    }
    throw err
  }
}

// POST /orgs/{org}/invitations by invitee_id or email. An optional team_ids
// array auto-adds the invitee to those teams on acceptance, so an email invite
// can land a student directly in the classroom team without a separate
// team-add. Exactly one of invitee_id / email must be provided. Owner-only.
export function createOrgInvitation(
  client: GitHubClient,
  input: {
    org: string
    invitee_id?: number
    email?: string
    role?: "direct_member" | "admin"
    team_ids?: number[]
  },
) {
  const { org, invitee_id, email, role = "direct_member", team_ids } = input

  if (invitee_id === undefined && !email) {
    throw new Error("createOrgInvitation requires invitee_id or email")
  }

  const body: {
    role: string
    invitee_id?: number
    email?: string
    team_ids?: number[]
  } = email !== undefined ? { email, role } : { invitee_id, role }
  if (team_ids && team_ids.length > 0) {
    body.team_ids = team_ids
  }

  return client.request(`/orgs/${org}/invitations`, {
    method: "POST",
    body,
  })
}

// Owner-only. A 404 (already gone) is treated as success so resend can proceed.
export async function cancelOrgInvitation(
  client: GitHubClient,
  input: { org: string; invitationId: number },
): Promise<void> {
  const { org, invitationId } = input

  try {
    await client.request(`/orgs/${org}/invitations/${invitationId}`, {
      method: "DELETE",
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return
    }
    throw err
  }
}

// DELETE /orgs/{org}/memberships/{username}: removes an active member or
// cancels a pending invite. Owner-only. 404 (not affiliated) treated as success.
export async function removeOrgMembership(
  client: GitHubClient,
  input: { org: string; username: string },
): Promise<void> {
  const { org, username } = input

  try {
    await client.request(`/orgs/${org}/memberships/${username}`, {
      method: "DELETE",
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return
    }
    throw err
  }
}

export type OrgMembershipState = "active" | "pending"

// PATCH /repos/{owner}/{repo} { archived: true }. Reversible and covered by the
// existing `repo` scope (unlike deletion, which needs delete_repo and a
// re-auth). The safe fallback when deletion isn't permitted. 404 = success.
export async function archiveRepo(
  client: GitHubClient,
  input: { owner: string; repo: string },
): Promise<void> {
  const { owner, repo } = input

  try {
    await client.request(`/repos/${owner}/${repo}`, {
      method: "PATCH",
      body: { archived: true },
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return
    }
    throw err
  }
}

// DELETE /repos/{owner}/{repo}. Needs the delete_repo OAuth scope. A token
// granted before delete_repo was requested (an older session) still 403s, so
// callers wanting "delete if possible, else archive" should catch the 403.
// 404 = success.
export async function deleteRepo(
  client: GitHubClient,
  input: { owner: string; repo: string },
): Promise<void> {
  const { owner, repo } = input

  try {
    await client.request(`/repos/${owner}/${repo}`, {
      method: "DELETE",
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return
    }
    throw err
  }
}

// GET /orgs/{org}/memberships/{username} -> state, or null on 404/error.
export async function getOrgMembershipState(
  client: GitHubClient,
  org: string,
  username: string,
): Promise<OrgMembershipState | null> {
  try {
    const membership = await client.request<{ state: OrgMembershipState }>(
      `/orgs/${org}/memberships/${username}`,
    )
    return membership.state ?? null
  } catch {
    return null
  }
}

// Error-safe "is this login an active org member?" — the boolean form of the
// membership re-check used across the enroll/reconcile paths. A missing username
// or any read failure resolves to false (never throws), so a yes/no-gate caller
// needn't re-inline the getOrgMembershipState === "active" + try/catch dance. A
// caller that must surface a tailored error on a non-member calls
// getOrgMembershipState directly to throw its own message.
export async function isActiveMember(
  client: GitHubClient,
  org: string,
  username: string,
): Promise<boolean> {
  if (!username.trim()) return false
  return (await getOrgMembershipState(client, org, username)) === "active"
}

type EnsureOrgMembershipResult = {
  // "active"/"pending" = no new invite sent; "invited" = a fresh one created.
  state: OrgMembershipState | "invited"
}

// Precheck membership, invite only when neither active nor pending, and treat a
// 422 (already member/invited) as success via a follow-up read. Optional
// teamIds attach to a fresh invite so accepting the single org invitation
// activates team membership atomically (no separate team invite that could
// leave the student org-active but team-pending).
export async function ensureOrgMembership(
  client: GitHubClient,
  input: {
    org: string
    username: string
    inviteeId: number
    teamIds?: number[]
  },
): Promise<EnsureOrgMembershipResult> {
  const { org, username, inviteeId, teamIds } = input

  const existing = await getOrgMembershipState(client, org, username)
  if (existing === "active" || existing === "pending") {
    return { state: existing }
  }

  try {
    await createOrgInvitation(client, {
      org,
      invitee_id: inviteeId,
      team_ids: teamIds,
    })
    return { state: "invited" }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const state = await getOrgMembershipState(client, org, username)
      if (state === "active" || state === "pending") {
        return { state }
      }
    }
    throw err
  }
}

// Resend an org invite without ever leaving the student invite-less. A fresh
// `ensureOrgMembership` recreates when the invitee is neither active nor
// pending. When they ARE still pending and we know the stale invitation id,
// cancel it and recreate so the invite is genuinely re-sent (previously this
// short-circuited on the pending precheck and re-sent nothing). If the recreate
// then 422s (a pending invite still blocks it), that existing invite is the
// live one, so leave it in place.
export async function resendOrgInvitation(
  client: GitHubClient,
  input: {
    org: string
    username: string
    inviteeId: number
    invitationId?: number
  },
): Promise<EnsureOrgMembershipResult> {
  const { org, username, inviteeId, invitationId } = input

  const result = await ensureOrgMembership(client, { org, username, inviteeId })

  if (result.state === "invited") {
    // A fresh invite was created; cancel the prior one if we know it.
    if (invitationId !== undefined) {
      await cancelOrgInvitation(client, { org, invitationId })
    }
    return result
  }

  // Still pending with a known stale invite: cancel it and recreate so the
  // student actually receives a new invitation. Active members are left alone.
  if (result.state === "pending" && invitationId !== undefined) {
    await cancelOrgInvitation(client, { org, invitationId })
    const recreated = await ensureOrgMembership(client, {
      org,
      username,
      inviteeId,
    })
    return recreated
  }

  return result
}

export {
  addStudentToClassroom,
  addStudentToClassroomWithConflictRetry,
  enrollStudentInClassroom,
  addStudentsToClassroom,
  bulkEnrollStudentsInClassroom,
  addStudentsToClassroomWithConflictRetry,
} from "@/api/mutations/students"

export async function getPendingOrgInvite(client: GitHubClient, org: string) {
  return client.request<GitHubOrgMembership>(`/user/memberships/orgs/${org}`)
}

// Sentinel returned by tryStep when fn throws: a warning (a tolerated status
// code) or a hard error. Callers detect the hard case via stepFailed().
type StepOutcome =
  { status: "warning"; message: string } | { status: "error"; message: string }

async function tryStep<T>({
  id,
  fn,
  onStepUpdate,
  options,
}: {
  id: InitStepId
  fn: () => Promise<T>
  onStepUpdate?: (update: InitStepUpdate) => void
  options?: { warningCodes: number[] }
}): Promise<T | StepOutcome> {
  const { warningCodes } = options || {}

  logSetup.info(`setup step: ${id} started`, { step: id })
  onStepUpdate?.({
    id,
    status: "running",
  })

  try {
    const result = await fn()

    const maybeStatus =
      typeof result === "object" &&
      result !== null &&
      "status" in result &&
      typeof result.status === "string"
        ? result.status
        : "complete"

    logSetup.info(
      `setup step: ${id} ${maybeStatus === "warning" ? "warning" : "complete"}`,
      {
        step: id,
      },
    )
    onStepUpdate?.({
      id,
      status: maybeStatus === "warning" ? "warning" : "complete",
      data: result,
      message:
        typeof result === "object" &&
        result !== null &&
        "message" in result &&
        typeof result.message === "string"
          ? result.message
          : undefined,
    })

    return result
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      warningCodes?.some((code) => err.status === code)
    ) {
      logSetup.warn(`setup step: ${id} warning`, {
        step: id,
        status: err.status,
      })
      onStepUpdate?.({
        id,
        status: "warning",
        error: err.message,
      })
      return {
        status: "warning" as const,
        message: err.message,
      }
    }

    const message = err instanceof Error ? err.message : "Unknown error"
    logSetup.error(`setup step: ${id} failed`, { step: id, err })
    onStepUpdate?.({
      id,
      status: "error",
      error: message,
    })
    return {
      status: "error" as const,
      message,
    }
  }
}

export type InitStepStatus =
  "pending" | "running" | "complete" | "warning" | "error" | "skipped"

export async function createOrgRepo(client: GitHubClient, org: string) {
  return client.request(`/orgs/${org}/repos`, {
    method: "POST",
    body: {
      name: "classroom50",
      private: true,
      auto_init: true,
      description:
        "Classroom 50 configuration, manifests, workflows, and scores",
    },
  })
}

export async function ensureClassroom50Repo(client: GitHubClient, org: string) {
  const existing = await getRepo(client, org, "classroom50")

  if (existing) {
    return { status: "complete" as const, created: false, repo: existing }
  }

  const repo = await createOrgRepo(client, org)

  return { status: "complete" as const, created: true, repo }
}

export type GitHubTreeResponse = {
  tree: Array<{
    path: string
    type: "blob" | "tree" | "commit"
    sha: string
  }>
  truncated: boolean
}

async function listTargetRepoBlobs(
  client: GitHubClient,
  org: string,
  branch = "main",
): Promise<Map<string, string>> {
  const ref = await client.request<{
    object: { sha: string }
  }>(`/repos/${org}/${CONFIG_REPO}/git/ref/heads/${branch}`)

  const commit = await client.request<{
    tree: { sha: string }
  }>(`/repos/${org}/${CONFIG_REPO}/git/commits/${ref.object.sha}`)

  const tree = await client.request<GitHubTreeResponse>(
    `/repos/${org}/${CONFIG_REPO}/git/trees/${commit.tree.sha}?recursive=1`,
  )

  if (tree.truncated) {
    throw new Error(
      `The ${org}/${CONFIG_REPO} tree is too large to safely inspect for missing skeleton files.`,
    )
  }

  return new Map(
    tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => [item.path, item.sha]),
  )
}

// The git blob SHA-1 GitHub reports for a file: sha1("blob <bytelen>\0" + body)
// over the UTF-8 bytes. Lets us compare a bundled skeleton file against the
// repo's tree entry by SHA, mirroring `git hash-object`. (See the CLI's
// gitBlobSHA in autograder_crud.go.)
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content)
  const header = new TextEncoder().encode(`blob ${body.length}\0`)
  const payload = new Uint8Array(header.length + body.length)
  payload.set(header)
  payload.set(body, header.length)
  const digest = await crypto.subtle.digest("SHA-1", payload)
  return bytesToHex(new Uint8Array(digest))
}

// A bundled skeleton file that needs writing, tagged with whether a file already
// exists at that path in the repo. `exists: false` is a create (always safe);
// `exists: true` is an overwrite of a drifted file (the GUI confirms these with
// the teacher first, mirroring the CLI's refresh prompt).
export type StaleSkeletonFile = SkeletonFile & { exists: boolean }

// Bounded retries for the skeleton commit's optimistic-rebase loop: re-diff
// against the freshly-read parent and re-PATCH the ref when a concurrent writer
// advances the tip during the (possibly long) overwrite-confirm pause.
const SKELETON_COMMIT_ATTEMPTS = 3

// A ref PATCH with force:false that loses a race returns 422 "Update is not a
// fast forward". Treat that (and only that) as retryable; everything else is a
// real error the caller should see. Exported so withGitConflictRetry treats a
// lost force:false race as retryable too (not just a 409) — the roster mutation
// family relies on that retry for concurrency safety.
export function isNonFastForward(err: unknown): boolean {
  if (!(err instanceof GitHubAPIError) || err.status !== 422) return false
  const message =
    err.message + " " + (typeof err.body === "string" ? err.body : "")
  return /fast forward|fast-forward/i.test(message)
}

// Skeleton files whose repo content is missing OR differs from the bundled
// version. Mirrors the CLI's diffSkeleton/refreshSkeleton: re-running setup
// picks up skeleton updates (new workflows, updated runner/scripts) instead of
// only filling in absent paths. Skeleton files aren't teacher-editable, so a
// drifted file is treated as stale; callers decide whether to overwrite.
export async function findStaleSkeletonFiles(
  client: GitHubClient,
  org: string,
): Promise<StaleSkeletonFile[]> {
  // The tree read and the default-branch read are independent — overlap them.
  const [existingBlobs, repo] = await Promise.all([
    listTargetRepoBlobs(client, org),
    client.request<GitHubRepo>(`/repos/${org}/${CONFIG_REPO}`),
  ])
  // Use the config repo's actual default branch (org policy can rename `main`).
  const defaultBranch = repo.default_branch || "main"

  // From the bundled skeleton — no runtime fetch from the CLI repo.
  const bundled = buildSkeletonFiles(defaultBranch)
  const bundledShas = await Promise.all(
    bundled.map((file) => gitBlobSha(file.content)),
  )

  const stale: StaleSkeletonFile[] = []
  bundled.forEach((file, i) => {
    const existingSha = existingBlobs.get(file.path)
    if (existingSha === undefined) {
      stale.push({ ...file, exists: false })
    } else if (bundledShas[i] !== existingSha) {
      stale.push({ ...file, exists: true })
    }
  })
  return stale
}

// Commits missing skeleton files and refreshes drifted ones. Overwriting an
// existing (drifted) file resets it to the bundled version, so callers can gate
// that with confirmOverwrite: invoked with the existing paths about to be
// overwritten, resolving false leaves those files untouched while still creating
// any missing ones. Omitting the hook overwrites without asking (the first-time
// wizard, where nothing pre-exists).
export async function ensureSkeletonFiles(
  client: GitHubClient,
  org: string,
  confirmOverwrite?: (paths: string[]) => Promise<boolean>,
) {
  const stale = await findStaleSkeletonFiles(client, org)

  if (stale.length === 0) {
    return { status: "complete" as const, created: [], skippedOverwrite: [] }
  }

  const overwritePaths = stale.filter((f) => f.exists).map((f) => f.path)
  let toWrite = stale
  let skippedOverwrite: string[] = []

  if (overwritePaths.length > 0 && confirmOverwrite) {
    const ok = await confirmOverwrite(overwritePaths)
    if (!ok) {
      // Declined: still create missing files, but leave drifted ones as-is.
      toWrite = stale.filter((f) => !f.exists)
      skippedOverwrite = overwritePaths
    }
  }

  if (toWrite.length === 0) {
    return {
      status: "complete" as const,
      created: [],
      skippedOverwrite,
      message:
        skippedOverwrite.length === 1
          ? "Left 1 customized skeleton file untouched."
          : `Left ${skippedOverwrite.length} customized skeleton files untouched.`,
    }
  }

  // Commit the stale files. The confirm modal can park this for an arbitrarily
  // long time, so the branch tip may have advanced (another tab/owner, any push)
  // by the time we write; updateRefForRepo uses force:false and rejects a
  // non-fast-forward rather than clobbering. On such a rejection we re-diff
  // against the new parent and retry, mirroring the CLI's refreshSkeleton
  // (init_skeleton.go): the retry sees the new parent and never re-commits an
  // already-current file.
  const writePaths = new Set(toWrite.map((f) => f.path))
  let changed = toWrite.map((f) => f.path)

  for (let attempt = 0; attempt < SKELETON_COMMIT_ATTEMPTS; attempt++) {
    // Attempt 0 reuses the diff we already computed; a retry re-diffs, where a
    // concurrent writer may have advanced the tip during the confirm pause (the
    // force:false PATCH's 422 below catches that race). The re-diff avoids
    // reverting that writer's changes and never re-commits an already-current
    // file; an empty re-diff is a clean no-op.
    const stillStale =
      attempt === 0
        ? toWrite
        : (await findStaleSkeletonFiles(client, org)).filter((f) =>
            writePaths.has(f.path),
          )
    if (stillStale.length === 0) {
      // A concurrent writer already brought our files up to date.
      changed = []
      break
    }
    changed = stillStale.map((f) => f.path)

    const branch = await getBranchRef(client, org)
    const commit = await getCommit(client, org, branch.object.sha)

    const tree = await createTreeRepo(client, {
      org,
      repo: "classroom50",
      base_tree: commit.tree.sha,
      tree: stillStale.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    })

    const newCommit = await createCommitRepo(client, {
      org,
      repo: "classroom50",
      message: prefixCommit("Bootstrap or refresh Classroom 50 skeleton"),
      tree: tree.sha,
      parents: [commit.sha],
    })

    try {
      await updateRefForRepo({
        client,
        owner: org,
        repo: "classroom50",
        branch: "main",
        commitSha: newCommit.sha,
      })
      break
    } catch (err) {
      // A non-fast-forward rejection means the tip moved between our read and
      // the PATCH; re-diff and retry. Any other error is real — rethrow it.
      if (!isNonFastForward(err) || attempt === SKELETON_COMMIT_ATTEMPTS - 1) {
        throw err
      }
    }
  }

  const updatedMsg =
    changed.length === 1
      ? "Updated 1 skeleton file to the latest version."
      : `Updated ${changed.length} skeleton files to the latest version.`
  const skippedMsg =
    skippedOverwrite.length > 0
      ? ` Left ${skippedOverwrite.length} customized file${
          skippedOverwrite.length === 1 ? "" : "s"
        } untouched.`
      : ""
  return {
    status: "complete" as const,
    created: changed,
    skippedOverwrite,
    message: `${updatedMsg}${skippedMsg}`,
  }
}

export type EnsurePagesResult = {
  status: "warning" | "complete"
  pagesEnabled: boolean
  pagesAlreadyEnabled: boolean
  visibilityPublic: boolean
  settingsUrl: string
  message: string
  pagesUrl: string
}

function expectedPagesUrl(org: string): string {
  return `https://${org}.github.io/classroom50/`
}

function pagesSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/settings/pages`
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown GitHub API error"
}

async function enableWorkflowPages(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<{
  enabled: boolean
  alreadyEnabled: boolean
}> {
  try {
    await client.request(`/repos/${owner}/${repo}/pages`, {
      method: "POST",
      body: {
        build_type: "workflow",
      },
    })

    return {
      enabled: true,
      alreadyEnabled: false,
    }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 409) {
      return {
        enabled: true,
        alreadyEnabled: true,
      }
    }

    throw new Error(
      `Could not enable GitHub Pages for ${owner}/${repo}: ${getErrorMessage(
        err,
      )}`,
      { cause: err },
    )
  }
}

async function setPagesPublic(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<{
  visibilityPublic: boolean
  warning?: string
}> {
  try {
    await client.request(`/repos/${owner}/${repo}/pages`, {
      method: "PUT",
      body: {
        public: true,
      },
    })

    return {
      visibilityPublic: true,
    }
  } catch (err) {
    return {
      visibilityPublic: false,
      warning: `Couldn't set Pages visibility to public for ${owner}/${repo}: ${getErrorMessage(
        err,
      )}. Toggle it manually at ${pagesSettingsUrl(
        owner,
        repo,
      )} → Visibility if students see 404s on the Pages URL.`,
    }
  }
}

export async function ensurePages(
  client: GitHubClient,
  org: string,
  repo = "classroom50",
): Promise<EnsurePagesResult> {
  const enableResult = await enableWorkflowPages(client, org, repo)
  const visibilityResult = await setPagesPublic(client, org, repo)
  const settingsUrl = pagesSettingsUrl(org, repo)

  // Trust the live read-back, not the write outcome: the writes are idempotent
  // and a re-run on an already-public site can 422 the visibility PUT while the
  // site is in fact correct. checkPages also keeps this in lockstep with the
  // audit.
  const verdict = await checkPages(client, org, repo)

  const base = {
    pagesEnabled: enableResult.enabled,
    pagesAlreadyEnabled: enableResult.alreadyEnabled,
    visibilityPublic: visibilityResult.visibilityPublic,
    settingsUrl,
    pagesUrl: expectedPagesUrl(org),
  }

  if (verdict.state === "enforced") {
    return {
      ...base,
      status: "complete",
      visibilityPublic: true,
      message: `${org}/${repo}: GitHub Pages builds from the workflow and the site is public.`,
    }
  }

  // Not enforced, or the read-back was unreadable: surface why, preferring the
  // write-time warning when we have one.
  const message =
    visibilityResult.warning ??
    (verdict.state === "unreadable"
      ? `${org}/${repo}: couldn't verify GitHub Pages (${verdict.detail ?? "read failed"}). Check it at ${settingsUrl} → Pages.`
      : `${org}/${repo}: GitHub Pages isn't fully configured (needs a workflow build and a public site). Set it at ${settingsUrl} → Pages.`)

  return {
    ...base,
    status: "warning",
    message,
  }
}

export type EnsureWorkflowPermissionsResult =
  | {
      status: "complete"
      repo: string
      defaultWorkflowPermissions: "read" | "write"
      managedByOrgPolicy: boolean
      message: string
    }
  | {
      status: "warning"
      repo: string
      defaultWorkflowPermissions: "read" | "write" | "unknown"
      managedByOrgPolicy: true
      message: string
    }

type WorkflowPermissionsResponse = {
  default_workflow_permissions: "read" | "write"
  can_approve_pull_request_reviews?: boolean
}

export async function setRepoWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<void> {
  await client.request(`/repos/${owner}/${repo}/actions/permissions/workflow`, {
    method: "PUT",
    body: {
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: false,
    },
  })
}

export async function getRepoWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<WorkflowPermissionsResponse> {
  return client.request<WorkflowPermissionsResponse>(
    `/repos/${owner}/${repo}/actions/permissions/workflow`,
  )
}

export async function ensureWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo = "classroom50",
): Promise<EnsureWorkflowPermissionsResult> {
  try {
    await setRepoWorkflowPermissions(client, owner, repo)

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      defaultWorkflowPermissions: "write",
      managedByOrgPolicy: false,
      message: `${owner}/${repo}: workflow permissions set to write.`,
    }
  } catch {
    // The PUT failed — typically a 409 because workflow write is
    // org/enterprise-managed. That's benign (the skeleton workflows declare
    // their own permissions), so re-read and report the effective state instead
    // of failing setup.
    return reportOrgWorkflowPermissions(client, owner, repo)
  }
}

// Report the effective (org-managed) workflow-permission state when the repo PUT
// didn't apply. A read default is acceptable because the skeleton workflows
// declare workflow-level write where needed, so both "write" and "read" report
// complete; only an unreadable state warrants a warning.
async function reportOrgWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<EnsureWorkflowPermissionsResult> {
  try {
    const permissions = await getRepoWorkflowPermissions(client, owner, repo)

    if (permissions.default_workflow_permissions === "write") {
      return {
        status: "complete",
        repo: `${owner}/${repo}`,
        defaultWorkflowPermissions: "write",
        managedByOrgPolicy: true,
        message: `${owner}/${repo}: workflow permissions are write, managed by organization policy.`,
      }
    }

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      defaultWorkflowPermissions: permissions.default_workflow_permissions,
      managedByOrgPolicy: true,
      message: `${owner}/${repo}: organization policy defaults workflows to read. This is okay — the Classroom 50 skeleton workflows declare workflow-level write where needed.`,
    }
  } catch {
    // Couldn't confirm the effective state — surface a warning to check rather
    // than a clean complete. Setup still proceeds (skeleton workflows
    // self-declare).
    return {
      status: "warning",
      repo: `${owner}/${repo}`,
      defaultWorkflowPermissions: "unknown",
      managedByOrgPolicy: true,
      message: `${owner}/${repo}: workflow permissions are managed by an organization policy and couldn't be read. Setup can continue because the Classroom 50 skeleton workflows declare their own permissions.`,
    }
  }
}

function actionsSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/settings/actions`
}

export type EnsureReusableWorkflowAccessResult =
  | {
      status: "complete"
      repo: string
      accessLevel: "organization"
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      repo: string
      accessLevel: "unknown"
      reason:
        | "permission_denied"
        | "policy_conflict"
        | "unexpected_status"
        | "unknown"
      message: string
      settingsUrl: string
    }

export async function ensureReusableWorkflowAccess(
  client: GitHubClient,
  owner: string,
  repo = "classroom50",
): Promise<EnsureReusableWorkflowAccessResult> {
  const settingsUrl = actionsSettingsUrl(owner, repo)

  try {
    await client.request(`/repos/${owner}/${repo}/actions/permissions/access`, {
      method: "PUT",
      body: {
        access_level: "organization",
      },
    })

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      accessLevel: "organization",
      settingsUrl,
      message: `${owner}/${repo}: reusable-workflow access enabled for the organization.`,
    }
  } catch (err) {
    const message = getErrorMessage(err)
    if (err instanceof GitHubAPIError) {
      if (err.status === 403) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          accessLevel: "unknown",
          reason: "permission_denied",
          settingsUrl,
          message: `${owner}/${repo}: couldn't enable reusable-workflow access for the organization. Student autograde workflows may fail with a 403 when resolving the reusable workflow. Retry with an org-admin token or toggle it manually at ${settingsUrl} → Access.`,
        }
      }

      if (err.status === 409) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          accessLevel: "unknown",
          reason: "policy_conflict",
          settingsUrl,
          message: `${owner}/${repo}: reusable-workflow access appears to be controlled by an organization or enterprise policy. Student autograde workflows may fail resolving the reusable workflow unless org-level access allows it. Review ${settingsUrl} → Access.`,
        }
      }
    }
    return {
      status: "warning",
      repo: `${owner}/${repo}`,
      accessLevel: "unknown",
      reason: "unknown",
      settingsUrl,
      message: `${owner}/${repo}: couldn't enable reusable-workflow access: ${message}. Student autograde workflows may fail resolving the reusable workflow. Review ${settingsUrl} → Access.`,
    }
  }
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value)
}

async function getDefaultBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<string> {
  const repoData = await client.request<GitHubRepo>(`/repos/${owner}/${repo}`)

  return repoData.default_branch
}

export async function putMinimalBranchProtection(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  await client.request(
    `/repos/${owner}/${repo}/branches/${encodePathPart(branch)}/protection`,
    {
      method: "PUT",
      body: {
        required_status_checks: null,
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      },
    },
  )
}

function branchSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/settings/branches`
}

export type EnsureBranchProtectionResult =
  | {
      status: "complete"
      repo: string
      branch: string
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      repo: string
      branch: string | null
      reason:
        "permission_denied" | "branch_not_found" | "unsupported" | "unexpected"
      message: string
      settingsUrl: string
    }

export async function ensureBranchProtection(
  client: GitHubClient,
  owner: string,
  repo = "classroom50",
  branch?: string,
): Promise<EnsureBranchProtectionResult> {
  const settingsUrl = branchSettingsUrl(owner, repo)

  let targetBranch: string | null = branch ?? null

  try {
    targetBranch ??= await getDefaultBranch(client, owner, repo)

    await putMinimalBranchProtection(client, owner, repo, targetBranch)

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      branch: targetBranch,
      settingsUrl,
      message: `${owner}/${repo}: branch protection applied to ${targetBranch}; force-pushes and deletions are disabled.`,
    }
  } catch (err) {
    const message = getErrorMessage(err)

    if (err instanceof GitHubAPIError) {
      if (err.status === 403) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          branch: targetBranch,
          reason: "permission_denied",
          settingsUrl,
          message: `${owner}/${repo}: branch protection could not be applied because the authenticated user lacks permission. Review branch protection manually at ${settingsUrl}.`,
        }
      }

      if (err.status === 404) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          branch: targetBranch,
          reason: "branch_not_found",
          settingsUrl,
          message: `${owner}/${repo}: branch protection could not be applied because the target branch was not found. The repository may still be initializing. Retry setup or review ${settingsUrl}.`,
        }
      }

      if (err.status === 422) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          branch: targetBranch,
          reason: "unsupported",
          settingsUrl,
          message: `${owner}/${repo}: GitHub rejected the branch protection request. This may be due to repository plan, ruleset, or policy constraints. Review ${settingsUrl}.`,
        }
      }
    }

    return {
      status: "warning",
      repo: `${owner}/${repo}`,
      branch: targetBranch,
      reason: "unexpected",
      settingsUrl,
      message: `${owner}/${repo}: branch protection could not be applied: ${message}. Review ${settingsUrl}.`,
    }
  }
}

export async function encryptSecret(publicKey: string, secret: string) {
  await sodium.ready

  const binkey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)
  const binsec = sodium.from_string(secret)

  const encBytes = sodium.crypto_box_seal(binsec, binkey)

  return sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL)
}

/**
 * Validates a fine-grained PAT before storing it as the service token by
 * reading the classroom50 repo *as the supplied token* and asserting it can
 * WRITE (permissions.push), mapping failures to actionable messages.
 *
 * The shared token needs Contents: Read and write AND Actions: Read and write on
 * student repos: collect-scores reads, but regrade (re-running an autograde run,
 * or pushing a submit/* tag) WRITES. We can't introspect a fine-grained PAT's
 * Actions scope via the API, so we assert the Contents write capability
 * (permissions.push) here — a read-only token is rejected — and the UI instructs
 * the teacher to also grant Actions: Read and write. Mirrors the CLI's
 * servicetoken.validateTokenWithClient.
 *
 * Caveat: GET /repos/{org}/classroom50 proves access to the config repo, not the
 * student repos the workflows touch (fine-grained PATs don't expose their repo
 * selection via the API). Hence the UI requires "All repositories".
 */
export async function validateServiceToken(
  token: string,
  org: string | undefined,
) {
  if (!org) throw new Error("org must be specified to validate a service token")

  const trimmed = token.trim()
  if (!trimmed) throw new Error("Enter a token before saving.")

  // NEVER log the token value — only the action + org.
  logSetup.info("validating service token", { org })

  const tokenClient = createGitHubClient({ token: trimmed })

  const scopeHint =
    `Create a fine-grained PAT with Resource owner = ${org}, Repository access = ` +
    "All repositories, Repository permissions → Contents: Read and write " +
    "AND Actions: Read and write (collecting scores reads; regrading re-runs " +
    "student autograde workflows and may push submit/* tags, which need write), " +
    "AND Organization permissions → Members: Read (collection is team-driven and " +
    "lists the classroom team — a separate section shown once the org is the " +
    "resource owner; not implied by any repository scope). " +
    "If your org requires PAT approval and you are not an org owner, an owner " +
    "must approve it first (owners' tokens are auto-approved)."

  let repo: { permissions?: { push?: boolean } }
  try {
    // Probes api.github.com directly with the pasted token, relying on GitHub's
    // permissive CORS on authenticated REST calls. The repo object's
    // `permissions` reflects the token's effective access (push === can write).
    repo = await tokenClient.request<{ permissions?: { push?: boolean } }>(
      `/repos/${org}/classroom50`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError) {
      if (err.status === 401) {
        throw new Error(
          "This token is invalid, expired, or revoked (401). Create a fresh fine-grained PAT and try again.",
          { cause: err },
        )
      }
      if (err.status === 403) {
        throw new Error(
          `This token can't access ${org}/classroom50 (403). ${scopeHint}`,
          { cause: err },
        )
      }
      if (err.status === 404) {
        throw new Error(
          `Couldn't find a classroom50 repository in ${org} (404). Check that the organization is correct and that setup has been run for it — this isn't necessarily a problem with the token itself.`,
          { cause: err },
        )
      }
    }
    // A fetch that never reached GitHub (network/CORS) throws a TypeError, not a
    // GitHubAPIError — don't blame the token for that.
    if (err instanceof TypeError) {
      throw new Error(
        `Couldn't reach GitHub to verify the token (network or CORS issue). Check your connection and try again. (${err.message})`,
        { cause: err },
      )
    }
    throw new Error(
      `Couldn't verify the token against ${org}/classroom50: ${getErrorMessage(
        err,
      )}`,
      { cause: err },
    )
  }

  // The token can read the repo, but regrade needs to write (re-run runs / push
  // submit/* tags). A read-only PAT reports permissions.push === false; reject
  // it with the same actionable scope hint.
  if (!repo.permissions?.push) {
    throw new Error(
      `This token can read ${org}/classroom50 but lacks write access — collecting scores needs read, but regrading needs write. ${scopeHint}`,
    )
  }

  // Contents/Actions are proven, but collection is team-driven: it lists the
  // classroom team's members, which needs the org-level Members: Read permission
  // — NOT implied by any repository scope, so a Contents/Actions-only token
  // passes every check above yet 403s on the first collect-scores API call.
  // Probe GET /orgs/{org}/members (same Members: Read permission the
  // team-members endpoint needs, but not dependent on a specific team existing).
  //
  // FAIL-OPEN on ambiguity: a 403/404 is a definitive scope gap and is rejected;
  // any other failure (401 after a 200 repo read, 5xx, rate-limit, network/CORS)
  // is inconclusive and allowed to proceed — the repo read above already proved
  // the token live, so blocking on this second round-trip's flakiness would
  // reject a valid token. The probe-token.yaml workflow is the exhaustive
  // post-provision signal.
  try {
    await tokenClient.request(
      `/orgs/${encodeURIComponent(org)}/members?per_page=1`,
    )
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      (err.status === 403 || err.status === 404)
    ) {
      throw new Error(
        `This token can read ${org}/classroom50 but can't read the org's members — collecting scores is team-driven and lists the classroom team, which needs Organization permissions → Members: Read. ${scopeHint}`,
        { cause: err },
      )
    }
    // Inconclusive (401/5xx/network) — proceed; the repo read already proved the
    // token valid.
  }
}

export const COLLECT_SCORES_WORKFLOW = "collect-scores.yaml"

// The regrade fan-out workflow in <org>/classroom50. Dispatched per assignment
// (optionally per repo owner); it re-runs each student repo's autograde
// workflow. Grading then happens asynchronously inside the student repos, so a
// follow-up collect-scores run refreshes the gradebook.
export const REGRADE_WORKFLOW = "regrade.yaml"

/**
 * Dispatches the classroom50 repo's `collect-scores.yaml` workflow (the same
 * nightly job that refreshes `scores.json`) so a teacher can pull fresh
 * submissions on demand.
 *
 * Returns `sinceRunId`: the newest collect-scores dispatch run before this POST
 * (null if none). The dispatch API returns no run id, so the caller finds the
 * triggered run as the oldest dispatch run with a larger id — monotonic, so no
 * clock comparison and unambiguous when dispatches race.
 *
 * @param classroom optional dispatch input to scope collection to one classroom;
 *   callers currently omit it to collect org-wide.
 */
export async function triggerScoreCollection(
  client: GitHubClient,
  org: string | undefined,
  classroom?: string,
): Promise<{ sinceRunId: number | null }> {
  if (!org) throw new Error("org must be specified to collect scores")

  const repo = await getRepo(client, org, "classroom50")
  if (!repo) {
    throw new Error(
      `${org}/classroom50 not found; run setup for this org first`,
    )
  }
  const ref = repo.default_branch || "main"

  // Snapshot the newest dispatch run id before the POST. Run ids are monotonic,
  // so the run this POST creates is the oldest dispatch run whose id exceeds it.
  const baseline = await client.request<{ workflow_runs: { id: number }[] }>(
    `/repos/${org}/classroom50/actions/workflows/${COLLECT_SCORES_WORKFLOW}/runs?event=workflow_dispatch&per_page=1`,
  )
  const sinceRunId = baseline.workflow_runs?.[0]?.id ?? null

  await client.request(
    `/repos/${org}/classroom50/actions/workflows/${COLLECT_SCORES_WORKFLOW}/dispatches`,
    {
      method: "POST",
      body: {
        ref,
        inputs: classroom ? { classroom } : {},
      },
    },
  )

  logWorkflows.info("dispatched collect-scores", { org, classroom, sinceRunId })
  return { sinceRunId }
}

/**
 * Dispatches the classroom50 repo's `regrade.yaml` workflow
 * to re-run the autograder for an assignment — the whole assignment, or
 * a single student when `owner` is supplied. Each targeted repo re-grades its
 * current `main` HEAD; grading runs asynchronously, so the gradebook is
 * refreshed by a subsequent collect-scores run.
 *
 * Returns `sinceRunId`: the newest regrade dispatch run before this POST (null
 * if none). The dispatch API returns no run id, so the caller binds to its own
 * run as the oldest dispatch run with a larger id (monotonic — no clock needed,
 * unambiguous when dispatches race). Mirrors triggerScoreCollection.
 *
 * @param classroom required dispatch input (the regrade workflow is always
 *   classroom-scoped, unlike collect which can sweep org-wide).
 * @param assignment required dispatch input (the assignment slug).
 * @param owner optional dispatch input — a single repo-owner login to regrade;
 *   omitted regrades every rostered student for the assignment.
 */
export async function triggerRegrade(
  client: GitHubClient,
  params: {
    org: string | undefined
    classroom: string | undefined
    assignment: string | undefined
    owner?: string
  },
): Promise<{ sinceRunId: number | null }> {
  const { org, classroom, assignment, owner } = params
  if (!org) throw new Error("org must be specified to regrade")
  if (!classroom) throw new Error("classroom must be specified to regrade")
  if (!assignment) throw new Error("assignment must be specified to regrade")

  // getRepo (for the dispatch ref) and the baseline snapshot are independent
  // reads; run them together. The baseline must still precede the POST below —
  // run ids are monotonic, so the run this POST creates is the oldest dispatch
  // run whose id exceeds the snapshot.
  const [repo, baseline] = await Promise.all([
    getRepo(client, org, "classroom50"),
    client.request<{ workflow_runs: { id: number }[] }>(
      `/repos/${org}/classroom50/actions/workflows/${REGRADE_WORKFLOW}/runs?event=workflow_dispatch&per_page=1`,
    ),
  ])
  if (!repo) {
    throw new Error(
      `${org}/classroom50 not found; run setup for this org first`,
    )
  }
  const ref = repo.default_branch || "main"
  const sinceRunId = baseline.workflow_runs?.[0]?.id ?? null

  // The workflow's `owner` input is optional; only send it when scoping to a
  // single student so an empty string isn't passed as a (no-op) filter.
  const inputs: Record<string, string> = { classroom, assignment }
  if (owner) inputs.owner = owner

  await client.request(
    `/repos/${org}/classroom50/actions/workflows/${REGRADE_WORKFLOW}/dispatches`,
    {
      method: "POST",
      body: { ref, inputs },
    },
  )

  logWorkflows.info("dispatched regrade", {
    org,
    classroom,
    assignment,
    owner: owner ?? "(all)",
    sinceRunId,
  })
  return { sinceRunId }
}

// Re-run the failed jobs of a run in <org>/classroom50 (the banner's retry).
// Re-running only failed jobs preserves the run id, so the tracker re-binds to
// the same run as it goes back in progress.
export async function rerunFailedRun(
  client: GitHubClient,
  org: string,
  runId: number,
): Promise<void> {
  logWorkflows.info("re-running failed jobs", { org, runId })
  await client.request(
    `/repos/${org}/classroom50/actions/runs/${runId}/rerun-failed-jobs`,
    { method: "POST" },
  )
}

export async function putRepoSecret(
  client: GitHubClient,
  owner: string | undefined,
  repo: string,
  name: string,
  plaintext: string,
) {
  if (!owner) throw new Error(`org must be specified to create a PAT`)
  const key = await client.request<{
    key_id: string
    key: string
  }>(`/repos/${owner}/${repo}/actions/secrets/public-key`)

  const encryptedValue = await encryptSecret(key.key, plaintext)

  // Log the write, never the plaintext/encrypted value.
  logSetup.info("writing repo Actions secret", { owner, repo, name })

  await client.request(`/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    body: {
      encrypted_value: encryptedValue,
      key_id: key.key_id,
    },
  })
}

type OrgActionsPermissions = {
  enabled_repositories: "all" | "none" | "selected"
  allowed_actions?: "all" | "local_only" | "selected"
  selected_actions_url?: string
}

export type EnsureOrgActionsEnabledResult =
  | {
      status: "complete"
      org: string
      enabledRepositories: "all"
      allowedActions: "all"
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      org: string
      enabledRepositories: "all" | "none" | "selected" | "unknown"
      allowedActions: "all" | "local_only" | "selected" | "unknown"
      reason:
        | "permission_denied"
        | "enterprise_policy"
        | "validation_failed"
        | "readback_failed"
        | "unknown"
      message: string
      settingsUrl: string
    }

function orgActionsSettingsUrl(org: string): string {
  return `https://github.com/organizations/${org}/settings/actions`
}

async function getOrgActionsPermissions(
  client: GitHubClient,
  org: string,
): Promise<OrgActionsPermissions> {
  return client.request<OrgActionsPermissions>(
    `/orgs/${org}/actions/permissions`,
  )
}

async function setOrgActionsPermissions(
  client: GitHubClient,
  org: string,
): Promise<void> {
  await client.request(`/orgs/${org}/actions/permissions`, {
    method: "PUT",
    body: {
      enabled_repositories: "all",
      allowed_actions: "all",
    },
  })
}

export async function ensureOrgActionsEnabled(
  client: GitHubClient,
  org: string,
): Promise<EnsureOrgActionsEnabledResult> {
  const settingsUrl = orgActionsSettingsUrl(org)

  try {
    await setOrgActionsPermissions(client, org)

    return {
      status: "complete",
      org,
      enabledRepositories: "all",
      allowedActions: "all",
      settingsUrl,
      message: `${org}: GitHub Actions enabled for all repositories.`,
    }
  } catch (err) {
    const message = getErrorMessage(err)

    let current: OrgActionsPermissions | null = null

    try {
      current = await getOrgActionsPermissions(client, org)
    } catch {
      // nothing for now, still want good warning info
    }

    const enabledRepositories = current?.enabled_repositories ?? "unknown"
    const allowedActions = current?.allowed_actions ?? "unknown"

    if (err instanceof GitHubAPIError) {
      if (err.status === 403) {
        return {
          status: "warning",
          org,
          enabledRepositories,
          allowedActions,
          reason: "permission_denied",
          settingsUrl,
          message:
            `${org}: couldn't enable GitHub Actions at the organization level. ` +
            `The authenticated user may lack org-owner/admin permissions, or an enterprise policy may block this change. ` +
            `Open ${settingsUrl} and set Actions permissions to allow repositories in this organization to run workflows.`,
        }
      }

      if (err.status === 409) {
        return {
          status: "warning",
          org,
          enabledRepositories,
          allowedActions,
          reason: "enterprise_policy",
          settingsUrl,
          message:
            `${org}: GitHub Actions permissions appear to be controlled by an organization or enterprise policy. ` +
            `Current setting: enabled_repositories="${enabledRepositories}", allowed_actions="${allowedActions}". ` +
            `Classroom50 workflows may not run until Actions are enabled. Review ${settingsUrl}.`,
        }
      }

      if (err.status === 422) {
        return {
          status: "warning",
          org,
          enabledRepositories,
          allowedActions,
          reason: "validation_failed",
          settingsUrl,
          message:
            `${org}: GitHub rejected the Actions permissions update. ` +
            `Current setting: enabled_repositories="${enabledRepositories}", allowed_actions="${allowedActions}". ` +
            `Review ${settingsUrl}. Original error: ${message}`,
        }
      }
    }

    return {
      status: "warning",
      org,
      enabledRepositories,
      allowedActions,
      reason: current ? "unknown" : "readback_failed",
      settingsUrl,
      message:
        `${org}: couldn't enable GitHub Actions. ` +
        `Current setting: enabled_repositories="${enabledRepositories}", allowed_actions="${allowedActions}". ` +
        `Review ${settingsUrl}. Original error: ${message}`,
    }
  }
}

export type EnsureOrgCanCreatePullRequestsResult =
  | {
      status: "complete"
      org: string
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      org: string
      reason: "permission_denied" | "policy_conflict" | "readback_failed"
      message: string
      settingsUrl: string
    }

type OrgWorkflowPermissions = {
  default_workflow_permissions: "read" | "write"
  can_approve_pull_request_reviews: boolean
}

// The opt-in Feedback PR, opened by each student repo's autograde workflow, is
// rejected unless the org-level "Allow GitHub Actions to create and approve pull
// requests" toggle is on (defaults off, settable only at the org level).
// Preserves default_workflow_permissions.
export async function ensureOrgCanCreatePullRequests(
  client: GitHubClient,
  org: string,
): Promise<EnsureOrgCanCreatePullRequestsResult> {
  const settingsUrl = orgActionsSettingsUrl(org)
  const path = `/orgs/${org}/actions/permissions/workflow`

  let current: OrgWorkflowPermissions
  try {
    current = await client.request<OrgWorkflowPermissions>(path)
  } catch (err) {
    return {
      status: "warning",
      org,
      reason: "readback_failed",
      settingsUrl,
      message: `${org}: couldn't read organization workflow permissions (${getErrorMessage(
        err,
      )}); GitHub Actions may be blocked from opening Feedback PRs. Enable "Allow GitHub Actions to create and approve pull requests" at ${settingsUrl}.`,
    }
  }

  if (current.can_approve_pull_request_reviews) {
    return {
      status: "complete",
      org,
      settingsUrl,
      message: `${org}: GitHub Actions is already allowed to create pull requests (Feedback PRs can open).`,
    }
  }

  try {
    await client.request(path, {
      method: "PUT",
      body: {
        default_workflow_permissions: current.default_workflow_permissions,
        can_approve_pull_request_reviews: true,
      },
    })

    return {
      status: "complete",
      org,
      settingsUrl,
      message: `${org}: enabled GitHub Actions to create pull requests (required for opt-in Feedback PRs).`,
    }
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      (err.status === 403 || err.status === 409)
    ) {
      return {
        status: "warning",
        org,
        reason: err.status === 403 ? "permission_denied" : "policy_conflict",
        settingsUrl,
        message: `${org}: couldn't enable Actions-created pull requests (${getErrorMessage(
          err,
        )}); the opt-in Feedback PR won't open until an org admin turns on "Allow GitHub Actions to create and approve pull requests" at ${settingsUrl}.`,
      }
    }

    throw err
  }
}

export type InitStepId =
  | "orgDefaults"
  | "orgActions"
  | "orgPrCreation"
  | "configRepo"
  | "skeleton"
  | "branchProtection"
  | "workflowPermissions"
  | "reusableWorkflowAccess"
  | "pages"
  | "rulesets"

export type InitStepUpdate = {
  id: InitStepId
  status: InitStepStatus
  title?: string
  message?: string
  error?: string
  data?: unknown
}

function stepFailed(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as { status: unknown }).status === "error"
  )
}

export async function initClassroom50({
  client,
  org,
  plan,
  onStepUpdate,
  confirmSkeletonOverwrite,
}: {
  client: GitHubClient
  org: string
  plan?: string
  onStepUpdate: (update: InitStepUpdate) => void
  // Invoked before drifted skeleton files are overwritten, with the paths at
  // risk. Resolving false skips the overwrite (missing files are still created)
  // — the GUI's "are you sure" prompt. Omitted on the first-time wizard, where
  // the repo is fresh and nothing pre-exists.
  confirmSkeletonOverwrite?: (paths: string[]) => Promise<boolean>
}) {
  const results: Partial<Record<InitStepId, unknown>> = {}

  logSetup.info("org setup: started", { org, plan })

  const buildResult = (status: "error" | "complete") => ({
    org,
    repo: "classroom50",
    ...results,
    status,
    pagesUrl: `https://${org}.github.io/classroom50/`,
  })

  results.orgDefaults = await tryStep({
    id: "orgDefaults",
    onStepUpdate,
    fn: async () => {
      const result = await repairOrgDefaults(client, org, plan)
      // Forward the whole result (not just status/message) so the board can list
      // the specific unenforced settings, and warn on ANY unenforced field so it
      // matches the check page rather than `ok`'s critical-only verdict.
      const status =
        result.unenforced.length > 0 || result.transient
          ? ("warning" as const)
          : ("complete" as const)
      return {
        status,
        message: result.message,
        unenforced: result.unenforced,
        enterprisePinned: result.enterprisePinned,
      }
    },
    options: { warningCodes: [403, 422] },
  })

  results.orgActions = await tryStep({
    id: "orgActions",
    onStepUpdate,
    fn: () => ensureOrgActionsEnabled(client, org),
  })

  results.orgPrCreation = await tryStep({
    id: "orgPrCreation",
    onStepUpdate,
    fn: () => ensureOrgCanCreatePullRequests(client, org),
  })

  results.configRepo = await tryStep({
    id: "configRepo",
    onStepUpdate,
    fn: () => ensureClassroom50Repo(client, org),
  })

  // configRepo is a hard prerequisite for every step below. If it errored,
  // continuing only cascades 404s and would report success on a
  // half-initialized org. Stop here.
  if (stepFailed(results.configRepo)) {
    logSetup.error("org setup: aborted (config repo step failed)", { org })
    return buildResult("error")
  }

  results.skeleton = await tryStep({
    id: "skeleton",
    onStepUpdate,
    fn: () => ensureSkeletonFiles(client, org, confirmSkeletonOverwrite),
  })

  // skeleton (workflows + scripts) — same hard-prerequisite gate.
  if (stepFailed(results.skeleton)) {
    logSetup.error("org setup: aborted (skeleton step failed)", { org })
    return buildResult("error")
  }

  results.pages = await tryStep({
    id: "pages",
    onStepUpdate,
    fn: () => ensurePages(client, org, "classroom50"),
  })

  results.workflowPermissions = await tryStep({
    id: "workflowPermissions",
    onStepUpdate,
    fn: () => ensureWorkflowPermissions(client, org, "classroom50"),
  })

  results.reusableWorkflowAccess = await tryStep({
    id: "reusableWorkflowAccess",
    onStepUpdate,
    fn: () => ensureReusableWorkflowAccess(client, org, "classroom50"),
  })

  results.branchProtection = await tryStep({
    id: "branchProtection",
    onStepUpdate,
    fn: () => ensureBranchProtection(client, org, "classroom50", "main"),
  })

  results.rulesets = await tryStep({
    id: "rulesets",
    onStepUpdate,
    fn: () => repairRulesets(client, org),
  })

  logSetup.info("org setup: completed", { org })
  return buildResult("complete")
}

export async function addRepoCollaborator(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
  permission?: "pull" | "triage" | "push" | "maintain" | "admin"
}) {
  const { client, org, repo, username, permission = "push" } = params

  // Only a definitive 404 (not an org member) blocks the add; transient errors
  // (rate limit, 5xx, private-membership 403) fall through to the PUT rather
  // than falsely rejecting a valid member.
  try {
    await client.requestRaw(
      `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) throw err
  }

  const res = await client.requestRaw(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      body: {
        permission,
      },
    },
  )

  return res
}

export async function removeRepoCollaborator(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
}) {
  const { client, org, repo, username } = params

  return client.request(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "DELETE",
    },
  )
}

export async function createBlob(
  client: GitHubClient,
  input: {
    org: string
    content: string
  },
) {
  return client.request<GitHubBlob>(
    `/repos/${input.org}/classroom50/git/blobs`,
    {
      method: "POST",
      body: {
        content: input.content,
        encoding: "utf-8",
      },
    },
  )
}

export async function createTreeFromEntries(
  client: GitHubClient,
  input: {
    org: string
    base_tree: string
    tree: Array<{
      path: string
      mode: "100644"
      type: "blob"
      sha: string
    }>
  },
) {
  return client.request<GitHubTree>(
    `/repos/${input.org}/classroom50/git/trees`,
    {
      method: "POST",
      body: {
        base_tree: input.base_tree,
        tree: input.tree,
      },
    },
  )
}

export type UpdateClassroomMetadataInput = {
  org: string
  slug: string
  name: string
  term: string
}

export type Classroom = {
  name: string
  short_name: string
  slug: string
  schema: string
  term: string
}
export type UpdateClassroomMetadataResult = {
  previousCommitSha: string
  baseTreeSha: string
  newTreeSha: string
  newCommitSha: string
  updatedRef: unknown
  classroom: Classroom
}
export type EditClassroomInput = {
  org: string
  slug: string
  // name/term are written only when provided — a pure archive/unarchive toggle
  // omits them so editClassroom's `...current` spread preserves the persisted
  // values (no stale-cache overwrite, no lost-update of a concurrent rename).
  term?: string
  name?: string
  // Archive lifecycle: false = archive, true = unarchive. Omitted leaves the
  // current value (or its absence) intact. See isClassroomArchived.
  active?: boolean
}

export type EditClassroomResult = Awaited<ReturnType<typeof editClassroom>>

// Merge an edit onto the current classroom.json record. Pure (no I/O):
// - spreads `...current` first so unknown/future fields a sibling binary wrote
//   ride through verbatim (the strict CLI round-trips this file);
// - writes name/term/active ONLY when provided, so a pure archive toggle
//   preserves the persisted name/term. `active` is a meaningful boolean (false =
//   archived), so unarchive writes `true` rather than deleting the key.
export function buildClassroomUpdate(
  current: Record<string, unknown>,
  fields: {
    name?: string
    term?: string
    active?: boolean
  },
): Record<string, unknown> {
  const { name, term, active } = fields
  return {
    ...current,
    ...(name !== undefined ? { name } : {}),
    ...(term !== undefined ? { term } : {}),
    ...(active !== undefined ? { active } : {}),
  }
}

export async function editClassroom(
  client: GitHubClient,
  input: EditClassroomInput,
) {
  const { org, slug, term, name, active } = input

  const ref = await getBranchRef(client, org)

  const commit = await getCommit(client, org, ref.object.sha)

  const current = await getClassroomJson(client, {
    org,
    classroom: slug,
    ref: ref.object.sha,
  })

  if (current.short_name !== slug) {
    throw new Error(
      `classroom.json slug mismatch: expected ${current.short_name}, got ${slug}`,
    )
  }

  // Archived classrooms are read-only — refuse a settings edit (name / term),
  // but let a lifecycle toggle through since unarchiving re-enables editing.
  // Gate on whether a settings field is actually present rather than on
  // `active === undefined`, so a payload bundling a settings change with
  // `active: false` (a stale tab, direct API call, or CLI/agent) can't slip an
  // edit past the guard by re-asserting the archived state.
  const editsSettings = name !== undefined || term !== undefined
  if (editsSettings && active !== true && isClassroomArchived(current)) {
    throw new Error(
      `Classroom "${slug}" is archived — settings are read-only. Unarchive it first to make changes.`,
    )
  }

  const next = buildClassroomUpdate(current, {
    name,
    term,
    active,
  })

  const blob = await createBlob(client, {
    org,
    content: JSON.stringify(next, null, 2) + "\n",
  })

  const tree = await createTreeFromEntries(client, {
    org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: `${slug}/classroom.json`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      },
    ],
  })

  const newCommit = await createCommit(client, {
    org,
    message: prefixCommit(`Update classroom ${slug}`),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
    classroom: slug,
  })

  const updatedRef = await updateRef(client, org, newCommit.sha)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    classroom: next,
  }
}
