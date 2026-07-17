import { useEffect, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { withGitConflictRetry } from "@/domain/classrooms"
import {
  migrateInstructorTeamToTeacher,
  type TeacherMigrationResult,
} from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { classroomTeamSlug } from "@/util/teamSlug"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubAPIError } from "@/github-core/errors"
import { logger } from "@/lib/logger"

const log = logger.scope("useTeacherTeamMigration")

type MigrationVars = { org: string; classroom: string }

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
export function useTeacherTeamMigration(
  org: string | undefined,
  classroom: string | undefined,
  enabled: boolean,
): void {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  // Keys with a migration in flight (or terminally failed) for this mount. A
  // Set — not a single slot — so a superseded run's late onError can't clear a
  // newer same-key run's guard (which would re-fire a duplicate concurrent
  // migration), and StrictMode's paired effect invocation is a no-op. A
  // transient failure deletes its key so a later render retries; a permanent
  // refusal (a 403 the viewer can't fix) keeps the key so the hopeless
  // create/grant/copy/commit chain doesn't re-fire on every entry.
  const inFlight = useRef<Set<string>>(new Set())

  const migration = useMutation<TeacherMigrationResult, Error, MigrationVars>({
    // Take org/classroom as variables (not closed-over props) so a run that
    // resolves after a fast classroom switch invalidates ITS OWN classroom's
    // caches, never the one now on screen.
    mutationFn: ({ org, classroom }) =>
      withGitConflictRetry(() =>
        migrateInstructorTeamToTeacher(client, org, classroom),
      ),
    onSuccess: (result, { org, classroom }) => {
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
    onError: (err, { org, classroom }) => {
      // Best-effort: a permission/transient failure just leaves the classroom on
      // the legacy team (still fully functional via backward-compat reads).
      // Retry a transient/conflict failure by releasing this run's key; keep a
      // permanent refusal latched so it doesn't re-fire on every entry.
      const key = `${org}/${classroom}`
      const isPermanent =
        err instanceof GitHubAPIError && err.isForbidden && !err.isRateLimited
      if (!isPermanent) inFlight.current.delete(key)
      log.warn("teacher team migration skipped", { org, classroom, err })
    },
  })

  const { mutate } = migration
  useEffect(() => {
    if (!enabled || !org || !classroom) return
    const key = `${org}/${classroom}`
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    mutate({ org, classroom })
  }, [enabled, org, classroom, mutate])
}

export default useTeacherTeamMigration
