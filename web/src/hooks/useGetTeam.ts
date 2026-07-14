import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getTeam } from "@/github-core/queries"

const useGetTeam = (org: string | undefined, classroom: string | undefined) => {
  const client = useGitHubClient()

  const teamQuery = useQuery({
    queryFn: () => getTeam(client, org ?? "", classroom ?? ""),
    queryKey: ["team", org, classroom],
    staleTime: 10 * 60 * 1000,
    enabled: Boolean(org) && Boolean(classroom),
  })

  return { team: teamQuery.data }
}

export default useGetTeam
