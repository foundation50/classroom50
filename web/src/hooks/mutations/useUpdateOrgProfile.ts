import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import {
  updateOrgProfile,
  type OrgProfileUpdate,
} from "@/github-core/mutations"
import type { GitHubOrgDetails } from "@/github-core/types"

// Edit an org's public profile (PATCH /orgs/{org}) — owner-only. The PATCH
// response is the canonical updated org, so seed it into the shared
// ["github","orgs",login] cache; the home card title/details reflect the change
// immediately with no extra GET. Readers carry a 10-min staleTime, so a refetch
// here would be redundant. The seed lives in the hook's onSuccess so a mid-flight
// unmount can't drop it; the success/error toasts stay at the call site.
export function useUpdateOrgProfile(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<GitHubOrgDetails, Error, OrgProfileUpdate>({
    mutationFn: (update) => updateOrgProfile(client, org, update),
    onSuccess: (updated) => {
      queryClient.setQueryData(githubKeys.orgDetails(org), updated)
    },
  })
}

export default useUpdateOrgProfile
