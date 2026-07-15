import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { ensureTeam } from "@/github-core/queries"
import { retryTransientGitHubError } from "@/github-core/errors"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/util/capabilities"

// ensureTeam is a WRITE (POST /orgs/{org}/teams) living in a useQuery: gate
// `enabled` on the manageOrg capability so a non-owner never fires a
// guaranteed-403 creation, and disable focus/reconnect refetch so a refocus
// can't re-fire the POST. The fail-closed retry predicate stops a definitive
// 403/404 from retrying; `unresolved` holds until ownership is known. This
// owner gate stays IN the hook: the only caller (AddStudent) sits under a
// RequireTeacher *staff* guard, so the owner narrowing lives here, not the guard.
const useEnsureTeam = (org: string, classroom: string) => {
  const client = useGitHubClient()
  const { githubOrgRole } = useGitHubOrgRole()

  const teamQuery = useQuery({
    queryKey: ["team", org, classroom],
    queryFn: () => ensureTeam(client, org, classroom),
    staleTime: 10 * 60 * 1000,
    enabled:
      Boolean(org) && Boolean(classroom) && can("manageOrg", { githubOrgRole }),
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
