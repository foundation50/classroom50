import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { getRepoPages, type RepoPagesInfo } from "@/github-core/mutations"

// One student repo's live GitHub Pages site (null = none configured), so the
// manage hub can show the real URL (which reflects an org custom domain) and
// build status. Read lazily: the hub enables it only while open and only once
// the repo read says a site exists. Short-lived so a just-run enable flips the
// row (the mutation also invalidates this key).
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
