import { useMutation } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { addRepositoryToTeam } from "@/github-core/mutations"
import type { RepoPermission } from "@/types/classroom"

// Set a team's role on one repo (idempotent PUT). No cache to invalidate: the
// team listing doesn't carry repo permissions.
export function useSetTeamRepoPermission() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (params: {
      org: string
      teamSlug: string
      repo: string
      permission: RepoPermission
    }) =>
      addRepositoryToTeam(client, {
        org: params.org,
        teamSlug: params.teamSlug,
        owner: params.org,
        repo: params.repo,
        permission: params.permission,
      }),
  })
}

export default useSetTeamRepoPermission
