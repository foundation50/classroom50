import { useCallback, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getAssignmentRepos, githubKeys } from "@/github-core/queries"
import type { GitHubRepo } from "@/github-core/types"
import { studentRepoName } from "@/util/studentRepo"
import useGetOrgRepos, { ORG_REPOS_STALE_MS } from "./useGetMyOrgRepos"

type Args = {
  org: string
  classroom: string
  assignment: string
  // Logins whose `<classroom>-<assignment>-<login>` repos the caller looks up.
  // `undefined` means the names are not derivable (a shared-repo assignment, or
  // a roster the caller could not derive them from; see
  // assignmentRepoCandidateLogins), so the whole org listing is read instead.
  logins: readonly string[] | undefined
  enabled?: boolean
}

// The org repo list as the submissions dashboard consumes it. For an
// individual assignment the candidate repo names are known from the roster, so
// getAssignmentRepos can read them directly when that beats walking the org;
// shared-repo assignments fall back to the full listing. Either way the result
// is a `GitHubRepo[]` the existing name-filtering consumers (acceptedUsernames,
// latestAssignmentPush, ...) read unchanged.
//
// The scoped read shares its cache with the full listing in both directions: a
// fresh full listing answers it without a request (except on a manual
// `refetch`, which marks that listing stale first), and a scoped read that
// ended up walking the whole org (a large roster) is stored under the
// full-listing key too, so the assignments page does not walk the org again.
export function useAssignmentRepos({
  org,
  classroom,
  assignment,
  logins,
  enabled = true,
}: Args) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const sortedLogins = useMemo(
    () =>
      logins === undefined
        ? undefined
        : [...new Set(logins.map((login) => login.trim().toLowerCase()))]
            .filter(Boolean)
            .sort(),
    [logins],
  )
  const scoped = sortedLogins !== undefined

  const scopedQuery = useQuery({
    queryKey: githubKeys.assignmentRepos(
      org,
      classroom,
      assignment,
      sortedLogins ?? [],
    ),
    queryFn: async ({ signal }) => {
      const fullKey = githubKeys.orgRepos(org)
      const cached = queryClient.getQueryState<GitHubRepo[] | null>(fullKey)
      // A recent full listing answers without a request, unless something has
      // invalidated it: a finished collect grants the staff teams repo access,
      // so a listing walked before it would still say "not accepted" for a repo
      // this viewer can now see, and the invalidation must reach the probe.
      if (
        cached?.data &&
        !cached.isInvalidated &&
        Date.now() - cached.dataUpdatedAt < ORG_REPOS_STALE_MS
      ) {
        return cached.data
      }
      const { repos, complete } = await getAssignmentRepos(
        client,
        org,
        (sortedLogins ?? []).map((login) =>
          studentRepoName(classroom, assignment, login),
        ),
        { signal },
      )
      if (complete) queryClient.setQueryData(fullKey, repos)
      return repos
    },
    staleTime: ORG_REPOS_STALE_MS,
    retry: false,
    enabled: enabled && scoped && Boolean(org && classroom && assignment),
  })
  const fullQuery = useGetOrgRepos(org, enabled && !scoped)

  // A manual refresh must reach GitHub. The scoped queryFn answers from a
  // fresh full listing, so mark that listing invalidated first (without
  // refetching its own observers) and the shortcut steps aside; the full
  // query's own refetch already re-walks.
  const refetchScoped = scopedQuery.refetch
  const refetch = useCallback(
    async (...args: Parameters<typeof refetchScoped>) => {
      await queryClient.invalidateQueries({
        queryKey: githubKeys.orgRepos(org),
        refetchType: "none",
      })
      return refetchScoped(...args)
    },
    [queryClient, org, refetchScoped],
  )

  return scoped ? { ...scopedQuery, refetch } : fullQuery
}
