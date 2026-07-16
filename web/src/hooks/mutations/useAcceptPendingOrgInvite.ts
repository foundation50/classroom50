import { useMutation, useQueryClient } from "@tanstack/react-query"
import { acceptPendingOrgInvite } from "@/domain/users"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Accept a pending org invite from the classes page's "join org" card (a
// best-effort accept, unlike useAcceptOrgInvite's accept-and-verify). Hook owns
// the membership + orgs-list invalidation; the call site keeps its own UI
// (the inline error alert reads mutation.isError off the returned result).
export function useAcceptPendingOrgInvite(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => acceptPendingOrgInvite(client, org),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.ownOrgMembership(org),
      })
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
  })
}

export default useAcceptPendingOrgInvite
