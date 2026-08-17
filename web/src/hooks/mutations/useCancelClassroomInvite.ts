import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { retireEmailInvite } from "@/domain/students"
import { invalidateClassroomTeam } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Cancel a pending classroom org invitation (staff OR student). Hook owns the
// bound team's members + invitations invalidation; the toasts stay at the call
// site (see ./README.md). Shared by the Settings staff section and the roster
// member modal. Returns the raw cancel outcome so a caller can distinguish a
// real cancellation from a stale (already-gone) invite id.
//
// For an email-only invitation (no login), pass `inviteEmail` so everything the
// invite left behind is retired with it: the per-invite metadata team holding
// that address, and its pending roster.csv row (best-effort; the GC and
// reconcile passes are the backstops). A username invitation has neither.
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
      // Only retire on a real cancellation: a stale id 404s (cancelled: false)
      // while a live invitation for the same address may still exist —
      // resendOrgInvitation recreates before cancelling — and dropping the row
      // there would delete the invite-time details of someone who can still
      // accept.
      if (result.cancelled && input.inviteEmail) {
        await retireEmailInvite(client, {
          org,
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
