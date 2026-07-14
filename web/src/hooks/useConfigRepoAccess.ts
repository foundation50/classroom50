import { useGitHubRepo } from "./github/hooks"
import { retryTransientGitHubError } from "./github/errors"
import { CONFIG_REPO } from "@/util/configRepo"
import { resolveTeacherVerdict } from "@/util/resolveRole"

// Org-scoped coarse staff verdict from the `classroom50` config repo: teacher =
// readable, student = 404, blocked = 403, unresolved = transient (fail-closed).
// This is the ORG-LEVEL staff signal for surfaces that have no classroom in
// scope (e.g. the org "Published" page, the classes drawer). CLASSROOM pages
// instead read the shared classroom context (useClassroomRoleContext), whose
// role resolves from per-classroom team membership — NOT this config-repo
// verdict. No "view as" clamp applies here — the preview is classroom-scoped.
export function useConfigRepoAccess(org: string | undefined) {
  const repoQuery = useGitHubRepo(org, CONFIG_REPO, {
    retry: retryTransientGitHubError,
  })

  const verdict = resolveTeacherVerdict({
    org,
    isSuccess: repoQuery.isSuccess,
    permissions: repoQuery.data?.permissions,
    error: repoQuery.error,
  })

  // A settled transient error leaves the verdict unresolved (a definitive
  // success/404/403 resolves it); surface it so the org-staff gate offers a
  // retry rather than an indefinite spinner (mirrors the classroom gates).
  const isError = !verdict.roleResolved && repoQuery.isError

  return { ...repoQuery, ...verdict, isError }
}
