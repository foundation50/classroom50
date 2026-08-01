import type { GitHubClient } from "@/github-core/client"
import type { AssignmentMode, RepoPermission } from "@/types/classroom"
import type { GitHubRepo } from "@/github-core/types"
import { getRepoPermissionForUser } from "@/github-core/queries"
import { defaultStudentPermission } from "@/types/classroom"
import { localizedError } from "@/types/localizedMessage"

// Grant the founder their repo role and verify it took: the grant must land at
// AT LEAST the requested level (a lower read-back is a grant that didn't take).
// A benign higher effective role (org base permission, or a repo creator GitHub
// won't self-downgrade) passes, since GitHub is the real ceiling and the
// teacher's level is a floor. isOwner is accepted for call-site symmetry with
// the CLI but no longer affects the >= check. CLI-aligned with inviteFounder in
// gh-student's accept.go.
export async function addFounderCollaborator(params: {
  client: GitHubClient
  owner: string
  repo: string
  username: string
  permission: RepoPermission
  isOwner?: boolean
}) {
  const { client, owner, repo, username, permission } = params

  await client.request(`/repos/${owner}/${repo}/collaborators/${username}`, {
    method: "PUT",
    body: {
      permission,
    },
  })

  const effective = await getRepoPermissionForUser({
    client,
    org: owner,
    repo,
    username,
  })

  if (
    !permissionSatisfies(effective.permission, effective.role_name, permission)
  ) {
    throw localizedError({
      key: "accept.errors.founderAccessMismatch",
      params: {
        username,
        permission,
        owner,
        repo,
        effective: effective.permission ?? "none",
        role: effective.role_name ?? "unknown",
      },
    })
  }
}

// The permission ladder low-to-high, so a read-back can be ranked against the
// role we wanted. GitHub's role_name reports the effective role (with maintain
// and admin distinct), while the legacy `permission` field collapses maintain
// into "write" and only distinguishes admin — so ranking on role_name is exact
// and ranking on the legacy field can only prove push/write and admin.
const PERMISSION_RANK: Record<string, number> = {
  read: 0,
  pull: 0,
  triage: 1,
  write: 2,
  push: 2,
  maintain: 3,
  admin: 4,
}

// Whether the read-back grants AT LEAST the role we set. role_name is
// authoritative when present. We verify ">=" rather than exact match: the
// effective role is the max of the direct grant, the org base repository
// permission, team grants, and creator-admin, so a benign residual above the
// wanted level (an org base perm higher than a below-default target, or a repo
// creator GitHub won't self-downgrade) must not fail an otherwise-good accept.
// The check still fails loudly when the student ends up BELOW the wanted role
// (the grant that didn't take). GitHub is the real enforcer of any ceiling;
// the teacher's level is a floor we guarantee. Mirrors gh-student's
// permissionSatisfies.
export function permissionSatisfies(
  legacy: string | undefined,
  roleName: string | undefined,
  want: RepoPermission,
): boolean {
  const wantRank = PERMISSION_RANK[want]
  if (roleName) {
    const gotRank = PERMISSION_RANK[roleName]
    if (gotRank === undefined) return false
    return gotRank >= wantRank
  }
  // Legacy field only: it can't distinguish triage/maintain (both collapse to
  // "write"), so the same >= compare is the best it can prove.
  const gotRank = PERMISSION_RANK[legacy ?? ""]
  if (gotRank === undefined) return false
  return gotRank >= wantRank
}

// Maps an assignment to the founder's accept-time repo role: the configured
// student_permission when set, else the mode default (least-privilege push for
// individual, admin for group). A group founder must hold at least admin to add
// teammates via `gh student invite`, so a group value below admin is clamped up.
// Mirrors gh-student's founderPermission.
export function founderPermission(
  mode: AssignmentMode,
  studentPermission?: RepoPermission,
): RepoPermission {
  const want = studentPermission ?? defaultStudentPermission(mode)
  if (mode === "group" && want !== "admin") return "admin"
  return want
}

// Rejects a group-shaped entry (max_group_size >= 2) whose mode isn't `group`:
// the founder would be under-privileged. Mirrors gh-student's assertModeCoherentForCreate.
export function assertAssignmentModeCoherent(
  slug: string,
  mode: AssignmentMode,
  maxGroupSize: number | undefined,
): void {
  if ((maxGroupSize ?? 0) > 0 && mode !== "group") {
    throw localizedError({
      key: "accept.errors.incoherentMode",
      params: { slug, maxGroupSize: maxGroupSize ?? 0, mode },
    })
  }
}

export async function patchRepoSurface(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  await client.request<GitHubRepo>(`/repos/${owner}/${repo}`, {
    method: "PATCH",
    body: {
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    },
  })
}
