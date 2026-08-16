import { useMutation, useQueryClient } from "@tanstack/react-query"
import { backfillInviteMetadata, syncRosterFromTeam } from "@/domain/students"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

// Backfill roster.csv from team membership (teacher-triggered and auto-run on
// open). First recovers any invited-email metadata from per-invite teams for
// accepted students (deleting those teams), then syncs identity/role rows from
// the classroom teams. Hook owns the roster-file invalidation; the
// up-to-date/added/failed toasts stay at the call site (see ./README.md).
export function useSyncRoster(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      // Best-effort: never let a metadata-recovery hiccup block the team sync
      // the teacher explicitly asked for.
      await backfillInviteMetadata(client, { org, classroom }).catch(() => {})
      return syncRosterFromTeam(client, { org, classroom })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      })
    },
  })
}
