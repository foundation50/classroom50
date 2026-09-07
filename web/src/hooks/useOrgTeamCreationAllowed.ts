import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import type { GitHubOrgDetails } from "@/github-core/types"

// Whether org members may create GitHub teams — the capability student-formed
// group assignments need (team_formation: student, where the founding student
// creates the team at accept).
//
// Fails open, like useOrgRepoCreationWarning: GitHub omits the
// member-privilege fields for non-admin readers, so only an explicit `false`
// blocks. Absent, unknown, or unreadable must never gate the mode.
export function orgTeamCreationAllowed(
  details: Pick<GitHubOrgDetails, "members_can_create_teams"> | undefined,
): boolean {
  return details?.members_can_create_teams !== false
}

// The read is shared: `useGetOrgPlanDetails` keys on githubKeys.orgDetails
// with a 10-minute staleTime, so mounting this on the assignment form costs
// no extra request on org-scoped pages.
const useOrgTeamCreationAllowed = (org: string | undefined): boolean => {
  const { data } = useGetOrgPlanDetails(org)
  return orgTeamCreationAllowed(data)
}

export default useOrgTeamCreationAllowed
