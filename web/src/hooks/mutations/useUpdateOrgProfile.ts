import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import {
  updateOrgProfile,
  type OrgProfileUpdate,
} from "@/github-core/mutations"
import type { GitHubOrgDetails } from "@/github-core/types"

// Edit an org's public profile (PATCH /orgs/{org}) — owner-only. On success it
// seeds the returned org into the shared ["github","orgs",login] cache so the
// home card title/details reflect the change immediately, then invalidates to
// refetch canonical state. Invalidation lives here so a mid-flight unmount can't
// drop it; the success/error toasts stay at the call site.
export function useUpdateOrgProfile(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<GitHubOrgDetails, Error, OrgProfileUpdate>({
    mutationFn: (update) => updateOrgProfile(client, org, update),
    onSuccess: (updated) => {
      queryClient.setQueryData(githubKeys.orgDetails(org), updated)
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgDetails(org),
      })
    },
  })
}

export default useUpdateOrgProfile
