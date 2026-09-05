import { useMutation, useQueryClient } from "@tanstack/react-query"
import { reconcileRoster } from "@/domain/students"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

// The teacher-triggered (and auto-run on open) roster reconciliation: one
// consolidated pass that recovers accepted email invites and syncs
// identity/role rows from the classroom teams (rows are never removed —
// unbacked email rows render as unlinked) — at
// most one commit (see reconcileRoster). Hook owns the roster-file
// invalidation; the up-to-date/added/failed toasts stay at the call site (see
// ./README.md). `excludeLogins` (typically the page's suppressed-logins
// snapshot) keeps the pass from re-appending a student unenrolled while it
// runs — the sync is no longer mutually exclusive with roster actions.
export function useSyncRoster(
  org: string,
  classroom: string,
  excludeLogins?: () => Set<string>,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    // Convergent and re-runnable, but a pass cut off between its GC deletes
    // and the roster commit still leaves a gap until the next open, so it adds
    // the same close-tab friction as the other multi-write chains. No in-page
    // copy: the pass is background work the teacher didn't start by hand.
    meta: { keepTabOpen: true },
    mutationFn: () =>
      reconcileRoster(client, { org, classroom, excludeLogins }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      })
      // The pass may have committed — refresh the "Updated x ago" caption.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.configFileCommit(org, rosterPath(classroom)),
      })
    },
  })
}
