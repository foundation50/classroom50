import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Cancel a pending staff org invitation. Hook owns the invitations + members
// invalidation for the bound team; the toasts stay at the call site (see
// ./README.md).
export function useCancelStaffInvite(org: string, teamSlug: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (invitationId: number) =>
      cancelOrgInvitation(client, { org, invitationId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamInvitations(org, teamSlug),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(org, teamSlug),
      })
    },
  })
}

export default useCancelStaffInvite
