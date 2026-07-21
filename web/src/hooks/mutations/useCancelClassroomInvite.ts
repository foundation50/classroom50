import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { invalidateClassroomTeam } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Cancel a pending classroom org invitation (staff OR student). Hook owns the
// bound team's members + invitations invalidation; the toasts stay at the call
// site (see ./README.md). Shared by the Settings staff section and the roster
// member modal. Returns the raw cancel outcome so a caller can distinguish a
// real cancellation from a stale (already-gone) invite id.
export function useCancelClassroomInvite(org: string, teamSlug: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (invitationId: number) =>
      cancelOrgInvitation(client, { org, invitationId }),
    onSuccess: () => invalidateClassroomTeam(queryClient, org, teamSlug),
  })
}

export default useCancelClassroomInvite
