import type { TFunction } from "i18next"

import { getName } from "@/util/students"
import { GitHubAPIError } from "@/github-core/errors"
import type { GitHubUser } from "@/github-core/types"
import type { RepoPermission, Student } from "@/types/classroom"

// The effective role from a collaborator's permission booleans (the list
// endpoint returns no role_name in our GitHubUser shape). Highest wins; triage
// isn't modeled by the booleans, so it reads back as pull — acceptable, since a
// no-op save is filtered out by the caller's change diff.
export const permissionFromFlags = (
  permissions: GitHubUser["permissions"],
): RepoPermission => {
  if (permissions.admin) return "admin"
  if (permissions.maintain) return "maintain"
  if (permissions.push) return "push"
  return "pull"
}

export const normalizeUsername = (username: string) =>
  username.trim().replace(/^@/, "").toLowerCase()

// The items whose settled promise rejected, by index into the input list.
export const rejectedItems = <T,>(
  results: PromiseSettledResult<unknown>[],
  items: T[],
): T[] =>
  results.flatMap((result, i) =>
    result.status === "rejected" ? [items[i]] : [],
  )

// The common GitHubAPIError failure reasons shared by the collaborator dialogs,
// using the groupCollaborators vocabulary. Returns undefined when the reason
// isn't one of these cases, so each dialog can layer its own branches (a 422
// conflict, an HTTP-status fallback, a "not applied" downgrade) around it.
export const describeGitHubApiFailure = (
  reason: unknown,
  t: TFunction,
): string | undefined => {
  if (reason instanceof GitHubAPIError) {
    if (reason.isRateLimited)
      return t("components.modals.groupCollaborators.failure.rateLimited")
    if (reason.status === 403)
      return t("components.modals.groupCollaborators.failure.forbidden")
    if (reason.status === 404)
      return t("components.modals.groupCollaborators.failure.notFound")
  }
  return undefined
}

// Two-line identity when we have a roster name (name + @handle), else just the
// @handle. Shared by owner, member, and marked-for-removal rows.
export const CollaboratorIdentity = ({
  login,
  students,
}: {
  login: string
  students: Student[]
}) => {
  const name = getName(login, students)
  return name ? (
    <>
      <span className="block truncate text-sm font-medium">{name}</span>
      <span className="block truncate font-mono text-xs text-base-content/70">
        @{login}
      </span>
    </>
  ) : (
    <span className="block truncate font-mono text-sm">@{login}</span>
  )
}
