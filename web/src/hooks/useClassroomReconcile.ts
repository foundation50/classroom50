import { useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { withGitConflictRetry } from "@/domain/classrooms"
import {
  reconcileClassroom,
  ClassroomReconcilePermanentError,
  type ClassroomReconcileResult,
} from "@/domain/reconcileClassroom"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { CONFIG_REPO } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"
import { logger } from "@/lib/logger"
import { useBestEffortOwnerReconcile } from "@/hooks/useBestEffortOwnerReconcile"

const log = logger.scope("useClassroomReconcile")

// Fire the centralized classroom self-check once per (org, classroom) a
// teacher/owner visits, best-effort. Mounted at the $org/$classroom boundary so
// a classroom converges on any owner entry rather than only when a role/roster
// op touches the missing resource. Owner-gated via `enabled` (a 403 for anyone
// else); the fire-once guard, latch, and concurrency invariant live in
// useBestEffortOwnerReconcile. Returns the pass's in-flight signal so pages
// can reflect "sync in progress" (e.g. the roster's banner).
export function useClassroomReconcile(
  org: string | undefined,
  classroom: string | undefined,
  enabled: boolean,
  creator?: string,
): { isPending: boolean } {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useBestEffortOwnerReconcile<ClassroomReconcileResult>({
    enabled,
    org,
    classroom,
    run: ({ org, classroom }) =>
      withGitConflictRetry(() =>
        reconcileClassroom(client, org, classroom, creator),
      ),
    // An archived classroom skips the team/roster writes (though it still
    // heals the description projection); release its key so a same-mount
    // un-archive re-reconciles rather than staying latched until remount.
    isTransientSuccess: (result) => result.skipped,
    // Invalidate only the slices that actually changed, keyed on the RUN's own
    // org/classroom (not the current one) so a late resolve after a fast switch
    // refreshes its own classroom. Union of what the two former hooks did.
    onSettled: (result, { org, classroom }) => {
      if (result.staffCreated.length > 0) {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.jsonFile(
            org,
            CONFIG_REPO,
            `${classroom}/classroom.json`,
          ),
        })
      }
      if (result.description.changed) {
        // Student enumeration reads GET /user/teams; refresh it so a teacher
        // previewing as a student picks up the rewritten description.
        void queryClient.invalidateQueries({ queryKey: githubKeys.myTeams() })
      }
      if (result.rosterChanged) {
        // The consolidated reconcile committed roster.csv (recovered emails,
        // removed dead rows, appended members, or refreshed roles) — refresh
        // the view.
        void queryClient.invalidateQueries({
          queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
        })
      }
    },
    // Latch as permanent only a 403 the viewer can't fix or the description
    // step's wrong-slug team 404 (a derived slug that never converges). Every
    // other 404 in the pass — a propagating config commit — is transient and
    // releases the key for a later retry, so
    // one blip can't disable the whole classroom heal for the mount.
    isPermanent: (err) =>
      err instanceof ClassroomReconcilePermanentError ||
      (err instanceof GitHubAPIError && err.isForbidden && !err.isRateLimited),
    logSkip: (err, { org, classroom }) =>
      log.warn("classroom reconcile skipped", { org, classroom, err }),
  })
}

export default useClassroomReconcile
