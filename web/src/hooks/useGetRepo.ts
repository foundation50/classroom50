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
    // Existence check that gates the accept flow; the accept mutation invalidates
    // the orgRepos key, not this one, so refetch per mount rather than inheriting
    // the global 30s floor and serving a stale "repo not created" on revisit.
    staleTime: 0,
  })
}

export default useGetRepo
