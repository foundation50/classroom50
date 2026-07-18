import { useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { withGitConflictRetry } from "@/domain/classrooms"
import {
  migrateInstructorTeamToTeacher,
  type TeacherMigrationResult,
} from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { classroomTeamSlug } from "@/util/teamSlug"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import { useBestEffortOwnerReconcile } from "@/hooks/useBestEffortOwnerReconcile"

const log = logger.scope("useTeacherTeamMigration")

// Self-heal the instructor -> teacher team rename on classroom entry, best-effort.
// Mounted once at the $org/$classroom boundary and fired once per (org,
// classroom) the viewer visits, so a classroom converges on any owner entry
// rather than only on the settings page.
//
// `enabled` MUST gate on the viewer being an org owner (the resolved teacher
// role): the migration creates/deletes teams and commits to the config repo, so
// firing it for a TA/student would only generate failing API calls. It never
// blocks the page and a failure is logged, not surfaced (a later entry retries).
//
// The migration itself is a no-op unless the classroom still records a legacy
// `teams.instructor` team, so entering an already-migrated (or brand-new)
// classroom does nothing beyond one classroom.json read. On a committed change
// it invalidates classroom.json and the team caches so the roster, RBAC, and
// capability gating re-resolve off the now-authoritative `-teacher` team.
//
// The fire-once guard, transient/permanent latch, and fire-once effect live in
// useBestEffortOwnerReconcile (shared with useTeamDescriptionBackfill); this
// hook supplies only the migration and its invalidation. The default
// permanent-error rule (a 403 the viewer can't fix) is exactly what's wanted.
export function useTeacherTeamMigration(
  org: string | undefined,
  classroom: string | undefined,
  enabled: boolean,
): void {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  useBestEffortOwnerReconcile<TeacherMigrationResult>({
    enabled,
    org,
    classroom,
    run: ({ org, classroom }) =>
      withGitConflictRetry(() =>
        migrateInstructorTeamToTeacher(client, org, classroom),
      ),
    onSettled: (result, { org, classroom }) => {
      if (!result.changed) return
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${classroom}/classroom.json`,
        ),
      })
      // Team-member lists for both the teacher and legacy instructor slugs so the
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
      // The viewer's per-team membership probes feed useClassroomRole; after the
      // instructor team is deleted, RBAC must re-resolve off the teacher team.
      void queryClient.invalidateQueries({ queryKey: ["team-membership"] })
    },
    logSkip: (err, { org, classroom }) =>
      log.warn("teacher team migration skipped", { org, classroom, err }),
  })
}

export default useTeacherTeamMigration
