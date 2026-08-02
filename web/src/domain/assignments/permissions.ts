import type { GitHubClient } from "@/github-core/client"
import type {
  AssignmentMode,
  RepoPermission,
  RepoFeatures,
} from "@/types/classroom"
import type { GitHubRepo } from "@/github-core/types"
import type { RepoFeaturePatch } from "@/github-core/mutations"
import { defaultStudentPermission } from "@/types/classroom"
import { localizedError } from "@/types/localizedMessage"
import { log } from "./accessPrimitives"

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

// The student-repo features accept controls. Re-exported from types/classroom
// (the leaf source of truth for the assignments-v1 `repo_features` shape) so
// resolveRepoFeaturesPatch and patchRepoSurface stay in lockstep with it and
// the Go RepoFeatures struct without re-declaring the shape.
export type { RepoFeatures }

// The GitHub PATCH body keys are single-sourced as RepoFeaturePatch in
// github-core/mutations/collaborators (re-exported via @/github-core/mutations);
// domain -> github-core is a permitted edge, so this file imports rather than
// re-declaring the shape. Only the keys present are sent; {} means no PATCH.

// Resolve an assignment's repo_features into the PATCH body to apply at accept
// time. Single per-key rule, shared with the CLI (accept.go):
//
//   - explicit true/false -> that value is sent.
//   - absent + templated  -> the TEMPLATE's current has_<key> (from
//     `templateFeatures`), because GitHub's POST /generate does NOT copy the
//     template's feature settings — a generated repo gets GitHub defaults, so
//     "inherit" must actively re-apply the template's value. When the template
//     read is unavailable (null / key missing), the key is omitted (fall back
//     to the generated repo's GitHub default rather than guessing).
//   - absent + template-less -> false (the code-only default).
//
// `templateFeatures` is the template repo's resolved has_* (from GET /repos on
// the template), or null when there's no template / the read failed. Only keys
// present in the returned patch are sent; an empty object means "send no PATCH".
export function resolveRepoFeaturesPatch(
  features: RepoFeatures | undefined,
  opts: { templated: boolean; templateFeatures?: RepoFeaturePatch | null },
): RepoFeaturePatch {
  const patch: RepoFeaturePatch = {}
  const resolveKey = (
    value: boolean | undefined,
    templateValue: boolean | undefined,
  ): boolean | undefined => {
    if (value !== undefined) return value // explicit on/off wins
    if (!opts.templated) return false // template-less: code-only default
    return templateValue // inherit the template's live value (undefined -> omit)
  }
  const tf = opts.templateFeatures ?? undefined
  const issues = resolveKey(features?.issues, tf?.has_issues)
  const wiki = resolveKey(features?.wiki, tf?.has_wiki)
  const projects = resolveKey(features?.projects, tf?.has_projects)
  const pullRequests = resolveKey(
    features?.pull_requests,
    tf?.has_pull_requests,
  )
  if (issues !== undefined) patch.has_issues = issues
  if (wiki !== undefined) patch.has_wiki = wiki
  if (projects !== undefined) patch.has_projects = projects
  if (pullRequests !== undefined) patch.has_pull_requests = pullRequests
  return patch
}

// The explicit-only subset of a repo_features PATCH: only the keys the teacher
// FORCED (a non-undefined `features.*`), never the inherited/default ones. Used
// as the fail-open retry body — an org that bans one INHERITED key (e.g.
// org-wide projects disabled) must not drop the teacher's co-resolved forced
// value in the same all-or-nothing PATCH.
export function explicitRepoFeaturesPatch(
  features: RepoFeatures | undefined,
): RepoFeaturePatch {
  const patch: RepoFeaturePatch = {}
  if (features?.issues !== undefined) patch.has_issues = features.issues
  if (features?.wiki !== undefined) patch.has_wiki = features.wiki
  if (features?.projects !== undefined) patch.has_projects = features.projects
  if (features?.pull_requests !== undefined) {
    patch.has_pull_requests = features.pull_requests
  }
  return patch
}

// Apply the resolved repo-feature PATCH to a just-created student repo. Sends
// the PATCH only when at least one key is set; an empty patch (templated +
// all-inherit) skips the request entirely so features carry through from
// POST /generate. Fail-open: a features PATCH can be rejected by org policy
// (e.g. org-wide repository-projects disabled 422s has_projects:true), and this
// runs inside the throwing accept "access" step — so a failure is logged and
// swallowed rather than stranding the student on a half-provisioned repo. The
// feature override is best-effort (GitHub is the real enforcer); the founder
// grant that follows is the load-bearing step.
//
// `explicitPatch` (when it is a proper non-empty subset of `patch`) is the
// fallback body: if the full PATCH is rejected because an org bans one
// INHERITED key, retry with only the teacher-forced keys so the forced
// override still lands. Mirrors the CLI's patchRepoFeatures.
export async function patchRepoSurface(
  client: GitHubClient,
  owner: string,
  repo: string,
  patch: RepoFeaturePatch,
  explicitPatch: RepoFeaturePatch = {},
) {
  if (Object.keys(patch).length === 0) return
  const send = (body: RepoFeaturePatch) =>
    client.request<GitHubRepo>(`/repos/${owner}/${repo}`, {
      method: "PATCH",
      body,
    })
  try {
    await send(patch)
  } catch (err) {
    let finalErr = err
    const explicitKeys = Object.keys(explicitPatch)
    if (
      explicitKeys.length > 0 &&
      explicitKeys.length < Object.keys(patch).length
    ) {
      try {
        await send(explicitPatch)
        return
      } catch (retryErr) {
        finalErr = retryErr
      }
    }
    log.warn("accept: repo-feature PATCH failed (non-fatal)", {
      owner,
      repo,
      patch,
      err: finalErr,
    })
  }
}
