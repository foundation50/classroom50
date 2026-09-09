import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  getRepoPages,
  githubKeys,
  type RepoPagesInfo,
} from "@/github-core/queries"

// One student repo's live Pages site (null = none), for the manage hub's real
// URL (which reflects an org custom domain) and build status. Read only while
// the hub is open and the repo read says a site exists; short-lived so a
// just-run enable flips the row (the mutation also invalidates this key).
export function useGetRepoPages(
  org: string | undefined,
  repo: string | undefined,
  options?: { enabled?: boolean },
) {
  const client = useGitHubClient()

  return useQuery<RepoPagesInfo | null>({
    queryKey: githubKeys.repoPages(org ?? "", repo ?? ""),
    queryFn: () => getRepoPages(client, org ?? "", repo ?? ""),
    enabled: Boolean(org && repo) && (options?.enabled ?? true),
    staleTime: 0,
    retry: false,
  })
}
