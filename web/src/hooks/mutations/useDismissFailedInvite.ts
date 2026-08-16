import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  cancelOrgInvitation,
  deleteInviteTeamForEmail,
} from "@/github-core/mutations"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Dismiss a failed/expired org invitation: cancel it on GitHub (removes it from
// the failed list; the mutation treats a 404 as success) and refresh the
// invite-status queries. Hook owns the invalidation; the error toast stays at
// the call site (see ./README.md). Sibling of useReinviteFailedInvite.
//
// For an email-only invitation (no login), pass `inviteEmail` so the per-invite
// metadata team holding that address is torn down with the dismissal
// (best-effort; the GC pass is the backstop).
export function useDismissFailedInvite(org: string, classroom: string) {
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
    onSuccess: () => invalidateInviteQueries(queryClient, org),
  })
}

export default useDismissFailedInvite
