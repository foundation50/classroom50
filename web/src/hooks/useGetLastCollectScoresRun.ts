import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getLastCollectScoresRun, githubKeys } from "@/github-core/queries"

const useGetLastCollectScoresRun = (org: string | undefined) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.lastCollectScoresRun(org ?? ""),
    queryFn: ({ signal }) => getLastCollectScoresRun(client, org ?? "", signal),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export default useGetLastCollectScoresRun
