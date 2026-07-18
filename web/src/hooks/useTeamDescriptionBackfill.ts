import { useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { withGitConflictRetry } from "@/domain/classrooms"
import {
  reconcileStudentTeamDescription,
  type TeamDescriptionReconcileResult,
} from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { logger } from "@/lib/logger"
import { useBestEffortOwnerReconcile } from "@/hooks/useBestEffortOwnerReconcile"

const log = logger.scope("useTeamDescriptionBackfill")

// Backfill the classroom50/team/v1 bootstrap record onto the student team's
// GitHub description when a teacher/owner enters a classroom, best-effort.
// Mounted once at the $org/$classroom boundary and fired once per (org,
// classroom) the viewer visits, so a classroom (created via the web GUI, or
// before this feature) converges on any owner entry — the web mirror of the
// CLI's write-at-create. Students read this record from GET /user/teams to
// enumerate their classrooms without config-repo access.
//
// `enabled` MUST gate on the resolved teacher role: PATCHing a secret team is an
// org-owner op, so firing it for a TA/student would only 403. It never blocks
// the page and a failure is logged, not surfaced (a later entry retries).
//
// A no-op unless the description drifts from the desired record, so entering an
// already-reconciled classroom does nothing beyond one classroom.json + one team
// read. On a rewrite it invalidates the viewer's /user/teams cache so a
// teacher previewing as a student sees the fresh record.
//
// The fire-once guard, transient/permanent latch, and fire-once effect live in
// useBestEffortOwnerReconcile (shared with useTeacherTeamMigration); this hook
// supplies only the reconcile, the invalidation, and the permanent-error rule.
export function useTeamDescriptionBackfill(
  org: string | undefined,
  classroom: string | undefined,
  enabled: boolean,
): void {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  useBestEffortOwnerReconcile<TeamDescriptionReconcileResult>({
    enabled,
    org,
    classroom,
    run: ({ org, classroom }) =>
      withGitConflictRetry(() =>
        reconcileStudentTeamDescription(client, org, classroom),
      ),
    onSettled: (result) => {
      if (!result.changed) return
      // The student-facing enumeration reads GET /user/teams; refresh it so a
      // teacher previewing as a student picks up the rewritten description.
      void queryClient.invalidateQueries({ queryKey: githubKeys.myTeams() })
    },
    // Latch as permanent a 403 the viewer can't fix AND a 404 on the TEAM read
    // (a wrong derived slug / deleted team never converges) so a hopeless
    // reconcile doesn't re-fire on every entry. A classroom.json read miss
    // arrives as ClassroomSourceReadError (not a GitHubAPIError), so it — like a
    // transient/rate-limited failure — releases its key for a later retry (a
    // fresh config commit may still be propagating).
    isPermanent: (err) =>
      err instanceof GitHubAPIError &&
      (err.isNotFound || (err.isForbidden && !err.isRateLimited)),
    logSkip: (err, { org, classroom }) =>
      log.warn("student team description backfill skipped", {
        org,
        classroom,
        err,
      }),
  })
}

export default useTeamDescriptionBackfill
