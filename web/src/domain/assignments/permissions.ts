import type { GitHubClient } from "@/github-core/client"
import type { AssignmentMode, RepoPermission } from "@/types/classroom"
import type { GitHubRepo } from "@/github-core/types"
import { defaultStudentPermission } from "@/types/classroom"
import { localizedError } from "@/types/localizedMessage"

// Grant the accepting student their role on their OWN repo. The student is the
// repo creator (they ran POST /generate), so this PUT is a self-directed
// collaborator change — including a self-downgrade below the default (a teacher
// can set student_permission to e.g. `pull`). We trust the PUT: it is the
// authenticated actor changing their own access, so a 2xx means it took.
//
// We deliberately do NOT read the effective permission back here. The
// /repos/{org}/{repo}/collaborators/{self}/permission sub-resource lags the PUT
// by a long, unbounded window right after a self-downgrade on a freshly
// generated repo — it 404s ("no readable collaborator record yet") well past
// any reasonable accept-run poll, even though the downgrade already applied. A
// read-back therefore produces false accept failures for the exact legitimate
// case it was meant to allow. The silently-ignored-downgrade guard belongs on
// the TEACHER write paths (the per-repo / bulk gradebook modals), where a
// DIFFERENT actor changes a student's role and a read-back can meaningfully
// confirm it; see addRepoCollaborator's `verify`. CLI-aligned with
// inviteFounder in gh-student's accept.go.
export async function addFounderCollaborator(params: {
  client: GitHubClient
  owner: string
  repo: string
  username: string
  permission: RepoPermission
}) {
  const { client, owner, repo, username, permission } = params

  await client.request(`/repos/${owner}/${repo}/collaborators/${username}`, {
    method: "PUT",
    body: {
      permission,
    },
  })
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

// Whether the read-back is the role we set. role_name is authoritative when
// present. isOwner picks the comparison, because it decides whether a HIGHER
// read-back is benign or a real failure:
//
//   - Org OWNER (isOwner): compare ">=". An owner holds unavoidable inherited
//     admin (and can't self-downgrade below it when they created the repo), so
//     a residual above the wanted level is benign — GitHub is the real ceiling
//     and the teacher's level is a floor we guarantee. Only a read-back BELOW
//     the wanted role (a grant that didn't take) fails.
//   - Non-owner MEMBER (!isOwner): compare "==". GitHub honors the direct
//     collaborator grant for a plain member, so the effective role should land
//     exactly on the target. A higher read-back means a requested downgrade was
//     silently ignored (e.g. a lingering creator/team/base grant), and for a
//     BELOW-default target (a teacher deliberately narrowing access) that
//     residual is exactly the over-access we must catch — so it fails loudly.
//
// Mirrors gh-student's permissionSatisfies.
export function permissionSatisfies(
  legacy: string | undefined,
  roleName: string | undefined,
  want: RepoPermission,
  isOwner: boolean,
): boolean {
  const wantRank = PERMISSION_RANK[want]
  // role_name is exact (maintain/admin distinct); the legacy field collapses
  // maintain into "write", so it can only prove push/write and admin — but the
  // owner-vs-member comparison choice is the same for both.
  const gotRank = PERMISSION_RANK[roleName || (legacy ?? "")]
  if (gotRank === undefined) return false
  return isOwner ? gotRank >= wantRank : gotRank === wantRank
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
