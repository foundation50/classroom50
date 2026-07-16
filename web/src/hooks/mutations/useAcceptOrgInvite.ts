import { useMutation, useQueryClient } from "@tanstack/react-query"
import { acceptAndVerifyOrgMembership } from "@/domain/users"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { orgMembershipsQueryKey } from "@/hooks/useGetOrgs"

// Accept a pending org invitation and verify membership landed. Hook owns the
// membership + orgs-list invalidation (data-consistency that must run even if
// the invite card unmounts); the success toast + navigation and the error toast
// stay at the call site via mutate(_, { onSuccess, onError }) (see ./README.md).
export function useAcceptOrgInvite(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => acceptAndVerifyOrgMembership(client, org),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orgMembershipsQueryKey })
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
  })
}

export default useAcceptOrgInvite
