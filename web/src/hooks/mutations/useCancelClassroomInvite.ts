import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  cancelOrgInvitation,
  deleteInviteTeamForEmail,
} from "@/github-core/mutations"
import { invalidateClassroomTeam } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Cancel a pending classroom org invitation (staff OR student). Hook owns the
// bound team's members + invitations invalidation; the toasts stay at the call
// site (see ./README.md). Shared by the Settings staff section and the roster
// member modal. Returns the raw cancel outcome so a caller can distinguish a
// real cancellation from a stale (already-gone) invite id.
//
// For an email-only invitation (no login), pass `inviteEmail` so the per-invite
// metadata team holding that address is torn down with the invite (best-effort;
// the GC pass is the backstop). A username invitation has no such team.
export function useCancelClassroomInvite(
  org: string,
  classroom: string,
  teamSlug: string,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: {
      invitationId: number
      inviteEmail?: string | null
    }) => {
      const result = await cancelOrgInvitation(client, {
        org,
        invitationId: input.invitationId,
      })
      if (input.inviteEmail) {
        await deleteInviteTeamForEmail(client, org, {
          classroom,
          email: input.inviteEmail,
        })
      }
      return result
    },
    onSuccess: () => invalidateClassroomTeam(queryClient, org, teamSlug),
  })
}

export default useCancelClassroomInvite
