import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys, REPO_READ_CONCURRENCY } from "./github/queries"
import type { GitHubUser } from "./github/types"
import { mapWithConcurrency } from "@/util/concurrency"

type GroupRepoRef = { owner: string; repoName: string }

// Eagerly (but bounded) fetch collaborators for the given group repos and return
// the union of member logins (lowercased). Populates the shared
// githubKeys.collaborators cache so the group rows' avatars and the Members
// modal read the same data, and so the submissions dashboard can drop every
// group member — not just founders — from the "no group" non-submitter list,
// keeping the view accurate on load without opening each modal (#245).
//
// The reads run through mapWithConcurrency at REPO_READ_CONCURRENCY so a class
// with many groups doesn't fan out one simultaneous request per repo (secondary
// rate limits); the trade is ~N throttled collaborator reads per assignment
// load, cached 1 min like the modal's own fetch.
export function useGroupRepoMemberLogins(
  org: string,
  repos: GroupRepoRef[],
): Set<string> {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  const repoNames = repos.map((r) => r.repoName)
  // Stable key over the repo set (sorted) so the batch only refires when the set
  // of group repos changes, not on every render.
  const repoKey = [...repoNames].sort().join(",")

  const { data } = useQuery({
    queryKey: [...githubKeys.all, "group-collaborators", org, repoKey] as const,
    queryFn: async () => {
      const logins = new Set<string>()
      await mapWithConcurrency(
        repoNames,
        REPO_READ_CONCURRENCY,
        async (repo) => {
          // affiliation=direct excludes org-inherited access (owners/admins),
          // matching useGetRepoCollaborators so both share one cache entry.
          const collaborators = await client.request<GitHubUser[]>(
            `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators?affiliation=direct`,
          )
          // Prime the per-repo cache the rows and Members modal read from.
          queryClient.setQueryData(
            githubKeys.collaborators(org, repo),
            collaborators,
          )
          for (const c of collaborators) logins.add(c.login.toLowerCase())
        },
      )
      return logins
    },
    staleTime: 60 * 1000,
    enabled: Boolean(org) && repoNames.length > 0,
  })

  const empty = useMemo(() => new Set<string>(), [])
  return data ?? empty
}
