import type { GitHubClient } from "@/github-core/client"
import type { AssignmentMode } from "@/types/classroom"
import type { GitHubRepo } from "@/github-core/types"
import { getRepoPermissionForUser } from "@/github-core/queries"

// Grant the founder their repo role and verify it took: a repo creator holds
// admin, so an individual self-downgrade GitHub silently ignores looks like
// success. isOwner tolerates an unavoidable residual admin (an org owner can't
// self-downgrade), since admin already covers push. CLI-aligned with
// inviteFounder in gh-student's accept.go.
export async function addFounderCollaborator(params: {
  client: GitHubClient
  owner: string
  repo: string
  username: string
  permission: "push" | "admin"
  isOwner?: boolean
}) {
  const { client, owner, repo, username, permission, isOwner = false } = params

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
    !permissionSatisfies(
      effective.permission,
      effective.role_name,
      permission,
      isOwner,
    )
  ) {
    throw new Error(
      `Expected ${username} to have "${permission}" access on ${owner}/${repo}, but GitHub reports "${effective.permission}" (role "${effective.role_name}") — a repo creator holds admin and a self-downgrade may be blocked by org policy. Ask your instructor to set your access to "${permission}".`,
    )
  }
}

// Whether the read-back matches the role we set. role_name is authoritative
// when present: a push target accepts push/write but must reject the
// more-privileged maintain/admin the legacy field would hide (GitHub collapses
// maintain->write, admin->admin). isOwner relaxes a push want to also accept
// admin: an org owner who created the repo can't self-downgrade (org policy
// blocks it), and admin is a superset of push. Mirrors gh-student's
// permissionSatisfies.
export function permissionSatisfies(
  legacy: string | undefined,
  roleName: string | undefined,
  want: "push" | "admin",
  isOwner = false,
): boolean {
  if (roleName) {
    if (want === "admin") return roleName === "admin"
    if (isOwner && roleName === "admin") return true
    return roleName === "push" || roleName === "write"
  }
  if (want === "admin") return legacy === "admin"
  if (isOwner && legacy === "admin") return true
  return legacy === "write"
}

// Maps assignment mode to the founder's repo role: least-privilege `push` for
// individual, `admin` for group. Mirrors gh-student's founderPermission.
export function founderPermission(mode: AssignmentMode): "push" | "admin" {
  return mode === "group" ? "admin" : "push"
}

// Rejects a group-shaped entry (max_group_size >= 2) whose mode isn't `group`:
// the founder would be under-privileged. Mirrors gh-student's assertModeCoherentForCreate.
export function assertAssignmentModeCoherent(
  slug: string,
  mode: AssignmentMode,
  maxGroupSize: number | undefined,
): void {
  if ((maxGroupSize ?? 0) > 0 && mode !== "group") {
    throw new Error(
      `Assignment "${slug}" has max_group_size ${maxGroupSize} but mode "${mode}" (want "group") — its published metadata is inconsistent. Ask your instructor to re-run assignment setup.`,
    )
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
