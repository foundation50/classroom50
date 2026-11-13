import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { githubKeys } from "@/github-core/queries"
import { listDirectCollaborators } from "@/github-core/repoReads"

const useGetRepoCollaborators = (
  org: string,
  repoName: string,
  options?: { enabled?: boolean },
) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.collaborators(org, repoName),
    queryFn: () => listDirectCollaborators(client, org, repoName),
    staleTime: 60 * 1000,
    enabled: Boolean(org && repoName) && (options?.enabled ?? true),
  })
}

export default useGetRepoCollaborators
