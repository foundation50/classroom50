import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { ensureTeam } from "./github/queries"
import { retryTransientGitHubError } from "./github/errors"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

// ensureTeam is a WRITE (POST /orgs/{org}/teams) living in a useQuery: gate
// `enabled` on the manageOrg capability so a non-owner never fires a
// guaranteed-403 creation, and disable focus/reconnect refetch so a refocus
// can't re-fire the POST. The fail-closed retry predicate stops a definitive
// 403/404 from retrying; `unresolved` holds until ownership is known.
const useEnsureTeam = (org: string, classroom: string) => {
  const client = useGitHubClient()
  const { orgRole } = useOrgRole()

  const teamQuery = useQuery({
    queryKey: ["team", org, classroom],
    queryFn: () => ensureTeam(client, org, classroom),
    staleTime: 10 * 60 * 1000,
    enabled:
      Boolean(org) && Boolean(classroom) && can("manageOrg", { orgRole }),
    retry: retryTransientGitHubError,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  return {
    team: teamQuery.data,
    teamQuery,
  }
}

export default useEnsureTeam
