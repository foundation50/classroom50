import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { ensureTeam } from "./github/queries"
import { retryTransientGitHubError } from "./github/errors"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

// ensureTeam performs a WRITE (POST /orgs/{org}/teams) — creating a team is
// owner-only. Gate the query on the manageOrg capability so a TA/instructor
// never fires a guaranteed-403 team creation, and use the fail-closed retry
// predicate so a definitive 403/404 doesn't retry (a plain useQuery otherwise
// retries the forbidden write with backoff). `unresolved` holds until ownership
// is known.
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
  })

  return {
    team: teamQuery.data,
    teamQuery,
  }
}

export default useEnsureTeam
