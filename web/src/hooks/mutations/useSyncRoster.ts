import { useMutation, useQueryClient } from "@tanstack/react-query"
import { reconcileRoster } from "@/domain/students"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

// The teacher-triggered (and auto-run on open) roster reconciliation: one
// consolidated pass that recovers accepted email invites, drops dead
// email-only rows, and syncs identity/role rows from the classroom teams — at
// most one commit (see reconcileRoster). Hook owns the roster-file
// invalidation; the up-to-date/added/failed toasts stay at the call site (see
// ./README.md).
export function useSyncRoster(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => reconcileRoster(client, { org, classroom }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      })
    },
  })
}
