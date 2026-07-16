import { useMutation, useQueryClient } from "@tanstack/react-query"
import { removeUserFromTeam } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { syncRosterAfterStaffChange } from "@/hooks/mutations/useAddStaffMember"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Remove a staff member from a classroom's role team. Hook owns the
// team-members + team-invitations invalidation and the best-effort roster sync;
// the success/error toasts stay at the call site (see ./README.md).
export function useRemoveStaffMember(
  org: string,
  classroom: string,
  teamSlug: string,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (username: string) =>
      removeUserFromTeam(client, { org, teamSlug, username }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(org, teamSlug),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamInvitations(org, teamSlug),
      })
      void syncRosterAfterStaffChange(client, queryClient, org, classroom)
    },
  })
}

export default useRemoveStaffMember
