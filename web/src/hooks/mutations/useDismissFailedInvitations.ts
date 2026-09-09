import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { GitHubAPIError } from "@/github-core/errors"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getErrorMessage } from "@/github-core/errorMessage"

export type DismissFailedInvitationsResult = {
  dismissed: number
  // Already gone on GitHub (a 404): reported separately so the caller doesn't
  // claim a dismissal that didn't happen, but not a failure either.
  alreadyGone: number
  failed: { invitationId: number; message: string }[]
  // Not attempted: GitHub rate-limited the batch partway, so the loop stopped
  // (hammering only extends the throttle). Retry later.
  deferred: number[]
}

// Dismiss GitHub failed-invitation records by id (the org Members page's
// orphan list). Sequential DELETEs; each outcome is bucketed rather than
// aborting the batch, so one stubborn record doesn't strand the rest, except a
// rate limit, which stops the loop and defers what is left. The hook owns the
// invite-query invalidation; toasts stay at the call site (see ./README.md).
// Multiple writes, so the tab is held open.
export function useDismissFailedInvitations(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: async (
      invitationIds: number[],
    ): Promise<DismissFailedInvitationsResult> => {
      const result: DismissFailedInvitationsResult = {
        dismissed: 0,
        alreadyGone: 0,
        failed: [],
        deferred: [],
      }
      for (const [i, invitationId] of invitationIds.entries()) {
        try {
          const { cancelled } = await cancelOrgInvitation(client, {
            org,
            invitationId,
          })
          if (cancelled) result.dismissed += 1
          else result.alreadyGone += 1
        } catch (err) {
          if (err instanceof GitHubAPIError && err.isRateLimited) {
            result.deferred = invitationIds.slice(i)
            break
          }
          result.failed.push({ invitationId, message: getErrorMessage(err) })
        }
      }
      return result
    },
    onSettled: () => invalidateInviteQueries(queryClient, org),
  })
}

export default useDismissFailedInvitations
