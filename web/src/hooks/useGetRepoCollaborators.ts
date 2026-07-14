import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { githubKeys } from "./github/queries"
import type { GitHubUser } from "./github/types"

const useGetRepoCollaborators = (
  org: string,
  repoName: string,
  options?: { enabled?: boolean },
) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.collaborators(org, repoName),
    queryFn: () => {
      // affiliation=direct excludes collaborators whose access is only inherited
      // from org membership (e.g. org owners, admin on every repo). Without it,
      // every owner shows as an admin collaborator, masking the real repo owner
      // (the student founder).
      return client.request<GitHubUser[]>(
        `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repoName)}/collaborators?affiliation=direct`,
      )
    },
    staleTime: 60 * 1000,
    enabled: Boolean(org && repoName) && (options?.enabled ?? true),
  })
}

export default useGetRepoCollaborators
