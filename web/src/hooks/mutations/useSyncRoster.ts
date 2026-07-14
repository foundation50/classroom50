import { useMutation, useQueryClient } from "@tanstack/react-query"
import { syncRosterFromTeam } from "@/domain/students"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

// Backfill roster.csv from team membership (teacher-triggered and auto-run on
// open). Hook owns the roster-file invalidation; the up-to-date/added/failed
// toasts stay at the call site (see ./README.md).
export function useSyncRoster(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => syncRosterFromTeam(client, { org, classroom }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      })
    },
  })
}
