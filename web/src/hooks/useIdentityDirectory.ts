import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { buildIdentityDirectory } from "@/domain/students/identityDirectory"

// The classroom identity directory, built ON DEMAND only (`enabled` gates it):
// it walks every classroom's teams and roster, so a roster with nothing to
// link must never pay for it.
export function useIdentityDirectory(org: string, enabled: boolean) {
  const client = useGitHubClient()
  return useQuery({
    queryKey: [...githubKeys.all, "identity-directory", org] as const,
    queryFn: () => buildIdentityDirectory(client, org),
    staleTime: 5 * 60 * 1000,
    enabled,
    retry: false,
  })
}
