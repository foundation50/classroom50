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
import { logger } from "@/lib/logger"

const log = logger.scope("useTeacherTeamMigration")

// Self-heal the instructor -> teacher team rename when classroom settings load.
// Fires once per (org, classroom) mount, best-effort: it never blocks the page
// and a failure is logged, not surfaced (the next settings load retries). Only
// the settings route (gated on the top staff role) mounts this, so the viewer
// is an org owner able to create/delete teams and commit to the config repo.
//
// The migration itself is a no-op unless the classroom still records a legacy
// `teams.instructor` team, so mounting this on an already-migrated (or brand-new)
// classroom does nothing beyond one classroom.json read. On a committed change
// it invalidates classroom.json and the team caches so the roster, RBAC, and
// capability gating re-resolve off the now-authoritative `-teacher` team.
export function useTeacherTeamMigration(
  org: string | undefined,
  classroom: string | undefined,
): void {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  // Guard against re-firing on every render / StrictMode double-invoke.
  const attemptedRef = useRef<string | null>(null)

  const migration = useMutation<TeacherMigrationResult, Error, void>({
    mutationFn: () =>
      withGitConflictRetry(() =>
        migrateInstructorTeamToTeacher(client, org!, classroom!),
      ),
    onSuccess: (result) => {
      if (!result.changed) return
      // classroom.json changed (teams block), so the detail read must refetch.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org!,
          CONFIG_REPO,
          `${classroom}/classroom.json`,
        ),
      })
      // Team-member lists for both the teacher and legacy instructor slugs so the
      // roster reflects the copied membership / removed team.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(
          org!,
          classroomTeamSlug(classroom!, "teacher"),
        ),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(
          org!,
          classroomTeamSlug(classroom!, "instructor"),
        ),
      })
      // The viewer's per-team membership probes feed useClassroomRole; after the
      // instructor team is deleted, RBAC must re-resolve off the teacher team.
      void queryClient.invalidateQueries({ queryKey: ["team-membership"] })
    },
    onError: (err) => {
      // Best-effort: a permission/transient failure just leaves the classroom on
      // the legacy team (still fully functional via backward-compat reads); the
      // next settings load retries.
      log.warn("teacher team migration skipped", { org, classroom, err })
    },
  })

  const { mutate } = migration
  useEffect(() => {
    if (!org || !classroom) return
    const key = `${org}/${classroom}`
    if (attemptedRef.current === key) return
    attemptedRef.current = key
    mutate()
  }, [org, classroom, mutate])
}

export default useTeacherTeamMigration
