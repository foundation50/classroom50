import { useMutation, useQueryClient } from "@tanstack/react-query"
import { purgeInviteTeams } from "@/domain/students"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Teacher-triggered invite-data cleanup: recover what the backfill still can
// into roster.csv, then delete every remaining stored invite email (hidden
// invite team) for the classroom. Hook owns the roster-file invalidation (the
// recovery may have written rows); the result/error toasts stay at the call
// site (see ./README.md).
export function usePurgeInviteTeams(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: () => purgeInviteTeams(client, { org, classroom }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.rosterFile(org, classroom),
      })
    },
  })
}

export default usePurgeInviteTeams
