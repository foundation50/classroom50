import { useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { withGitConflictRetry } from "@/domain/classrooms"
import {
  reconcileClassroom,
  type ClassroomReconcileResult,
} from "@/domain/reconcileClassroom"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { classroomTeamSlug } from "@/util/teamSlug"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import { useBestEffortOwnerReconcile } from "@/hooks/useBestEffortOwnerReconcile"

const log = logger.scope("useClassroomReconcile")

// Fire the centralized classroom self-check once per (org, classroom) a
// teacher/owner visits, best-effort. Mounted at the $org/$classroom boundary so
// a classroom created via the GUI, or before a given resource existed, converges
// on any owner entry rather than only when a role/roster op happens to touch the
// missing resource. Subsumes the former useTeacherTeamMigration +
// useTeamDescriptionBackfill (their reconciles are steps of reconcileClassroom)
// and additionally re-affirms the staff teams + their config-repo grants.
//
// `enabled` MUST gate on the resolved teacher role: every step is an org-owner
// op that would only 403 for a TA/student. It never blocks the page and a
// failure is logged, not surfaced (a later entry retries per the shared latch).
//
// The fire-once guard, transient/permanent latch, and org/classroom-as-variable
// concurrency invariant live in useBestEffortOwnerReconcile.
export function useClassroomReconcile(
  org: string | undefined,
  classroom: string | undefined,
  enabled: boolean,
): void {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  useBestEffortOwnerReconcile<ClassroomReconcileResult>({
    enabled,
    org,
    classroom,
    run: ({ org, classroom }) =>
      withGitConflictRetry(() => reconcileClassroom(client, org, classroom)),
    // Invalidate only the slices that actually changed, keyed on the RUN's own
    // org/classroom (not the current one) so a late resolve after a fast switch
    // refreshes its own classroom. Union of what the two former hooks did.
    onSettled: (result, { org, classroom }) => {
      if (result.migration.changed || result.staffCreated.length > 0) {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.jsonFile(
            org,
            CONFIG_REPO,
            `${classroom}/classroom.json`,
          ),
        })
      }
      if (result.migration.changed) {
        // Membership of both the teacher and legacy instructor slugs, so the
        // roster reflects the copied membership / removed team.
        void queryClient.invalidateQueries({
          queryKey: githubKeys.teamMembers(
            org,
            classroomTeamSlug(classroom, "teacher"),
          ),
        })
        void queryClient.invalidateQueries({
          queryKey: githubKeys.teamMembers(
            org,
            classroomTeamSlug(classroom, "instructor"),
          ),
        })
        // The viewer's per-team membership probes feed useClassroomRole; after
        // the instructor team is deleted, RBAC must re-resolve off the teacher.
        void queryClient.invalidateQueries({ queryKey: ["team-membership"] })
      }
      if (result.description.changed) {
        // Student enumeration reads GET /user/teams; refresh it so a teacher
        // previewing as a student picks up the rewritten description.
        void queryClient.invalidateQueries({ queryKey: githubKeys.myTeams() })
      }
    },
    // Latch as permanent a 403 the viewer can't fix AND a 404 on a TEAM read (a
    // wrong derived slug / deleted team never converges) — the stricter of the
    // two former rules. A classroom.json read miss arrives as
    // ClassroomSourceReadError (not a GitHubAPIError) and so, like a transient
    // failure, releases its key for a later retry.
    isPermanent: (err) =>
      err instanceof GitHubAPIError &&
      (err.isNotFound || (err.isForbidden && !err.isRateLimited)),
    logSkip: (err, { org, classroom }) =>
      log.warn("classroom reconcile skipped", { org, classroom, err }),
  })
}

export default useClassroomReconcile
