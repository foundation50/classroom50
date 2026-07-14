import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { githubKeys, listOrgMembers } from "@/github-core/queries"

const useGetOrgMembers = (org: string) => {
  const client = useGitHubClient()
  const {
    data: members,
    isError,
    isLoading,
  } = useQuery({
    queryKey: githubKeys.orgMembers(org),
    queryFn: () => listOrgMembers(client, org),
    // Guard against an empty org (e.g. a hook called before a route's
    // missing-params guard); without this, org="" would fire GET /orgs//members.
    enabled: Boolean(org),
    staleTime: 10 * 60 * 1000,
  })

  return { members, isError, isLoading }
}

export default useGetOrgMembers
