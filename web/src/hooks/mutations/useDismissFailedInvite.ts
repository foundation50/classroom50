import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Dismiss a failed/expired org invitation: cancel it on GitHub (removes it from
// the failed list; the mutation treats a 404 as success) and refresh the
// invite-status queries. Hook owns the invalidation; the error toast stays at
// the call site (see ./README.md). Sibling of useReinviteFailedInvite.
export function useDismissFailedInvite(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (invitationId: number) =>
      cancelOrgInvitation(client, { org, invitationId }),
    onSuccess: () => invalidateInviteQueries(queryClient, org),
  })
}

export default useDismissFailedInvite
