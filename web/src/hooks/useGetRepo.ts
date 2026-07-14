import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getRepo } from "@/github-core/repoReads"

const useGetRepo = (
  org: string | undefined,
  path: string,
  options?: { enabled?: boolean },
) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: ["github", "repo", org, path],
    queryFn: () => getRepo(client, org ?? "", path),
    enabled: Boolean(org && path) && (options?.enabled ?? true),
  })
}

export default useGetRepo
