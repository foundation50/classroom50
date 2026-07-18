import { useEffect, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { withGitConflictRetry } from "@/domain/classrooms"
import {
  reconcileStudentTeamDescription,
  type TeamDescriptionReconcileResult,
} from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { logger } from "@/lib/logger"

const log = logger.scope("useTeamDescriptionBackfill")

type BackfillVars = { org: string; classroom: string }

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
export function useTeamDescriptionBackfill(
  org: string | undefined,
  classroom: string | undefined,
  enabled: boolean,
): void {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  // Keys with a reconcile in flight (or terminally failed) for this mount. A
  // Set (mirrors useTeacherTeamMigration) so a superseded run's late onError
  // can't clear a newer same-key run's guard and StrictMode's paired invoke is
  // a no-op. A transient failure deletes its key so a later render retries; a
  // permanent 403 (a viewer who can't PATCH) or 404 (a team that never resolves)
  // stays latched so it doesn't re-fire.
  const inFlight = useRef<Set<string>>(new Set())

  const backfill = useMutation<
    TeamDescriptionReconcileResult,
    Error,
    BackfillVars
  >({
    // org/classroom as variables (not closed-over) so a run resolving after a
    // fast classroom switch invalidates ITS OWN classroom's caches.
    mutationFn: ({ org, classroom }) =>
      withGitConflictRetry(() =>
        reconcileStudentTeamDescription(client, org, classroom),
      ),
    onSuccess: (result) => {
      if (!result.changed) return
      // The student-facing enumeration reads GET /user/teams; refresh it so a
      // teacher previewing as a student picks up the rewritten description.
      void queryClient.invalidateQueries({ queryKey: githubKeys.myTeams() })
    },
    onError: (err, { org, classroom }) => {
      const key = `${org}/${classroom}`
      // Latch as permanent both a 403 the viewer can't fix AND a 404 team read
      // (a wrong derived slug / deleted team never converges) so a hopeless
      // reconcile doesn't re-fire the classroom.json + team read on every entry.
      // A transient/rate-limited failure releases its key so a later render retries.
      const isPermanent =
        err instanceof GitHubAPIError &&
        (err.isNotFound || (err.isForbidden && !err.isRateLimited))
      if (!isPermanent) inFlight.current.delete(key)
      log.warn("student team description backfill skipped", {
        org,
        classroom,
        err,
      })
    },
  })

  const { mutate } = backfill
  useEffect(() => {
    if (!enabled || !org || !classroom) return
    const key = `${org}/${classroom}`
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    mutate({ org, classroom })
  }, [enabled, org, classroom, mutate])
}

export default useTeamDescriptionBackfill
