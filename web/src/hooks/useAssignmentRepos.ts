import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getOrgRepos, githubKeys } from "@/github-core/queries"
import { studentRepoName } from "@/util/studentRepo"
import useGetOrgRepos, { ORG_REPOS_STALE_MS } from "./useGetMyOrgRepos"

type Args = {
  org: string
  classroom: string
  assignment: string
  // Logins whose `<classroom>-<assignment>-<login>` repos the caller looks up.
  // `undefined` means the names are not derivable (a shared-repo assignment, or
  // the roster hasn't loaded), so the whole org listing is read instead.
  logins: readonly string[] | undefined
  enabled?: boolean
}

// The org repo list as the submissions dashboard consumes it. For an
// individual assignment the candidate repo names are known from the roster, so
// getOrgRepos can read them directly when that beats walking the org (see
// candidateNames); shared-repo assignments fall back to the full listing.
// Either way the result is a `GitHubRepo[]` the existing name-filtering
// consumers (acceptedUsernames, latestAssignmentPush, ...) read unchanged.
export function useAssignmentRepos({
  org,
  classroom,
  assignment,
  logins,
  enabled = true,
}: Args) {
  const client = useGitHubClient()
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
    queryFn: ({ signal }) =>
      getOrgRepos(client, org, {
        signal,
        candidateNames: (sortedLogins ?? []).map((login) =>
          studentRepoName(classroom, assignment, login),
        ),
      }),
    staleTime: ORG_REPOS_STALE_MS,
    retry: false,
    enabled: enabled && scoped && Boolean(org && classroom && assignment),
  })
  const fullQuery = useGetOrgRepos(org, enabled && !scoped)

  return scoped ? scopedQuery : fullQuery
}
