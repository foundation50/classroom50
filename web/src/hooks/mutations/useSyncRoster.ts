import { useMutation, useQueryClient } from "@tanstack/react-query"
import { syncRosterFromTeam } from "@/api/mutations/students"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

// Backfill roster.csv from team membership (teacher-triggered and auto-run on
// open). Per the TanStack split (see hooks/mutations), the hook owns only the
// roster-file invalidation that must always run; the caller passes the
// up-to-date / added / failed toasts via `mutate` so they skip when unmounted.
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
