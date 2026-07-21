import type { GitHubClient } from "@/github-core/client"
import { getClassroomJson } from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import { isClassroomArchived, type StaffRole } from "@/types/classroom"
import {
  ensureClassroomTeam,
  ensureStaffTeams,
  migrateInstructorTeamToTeacher,
  reconcileStudentTeamDescription,
  type TeacherMigrationResult,
  type TeamDescriptionReconcileResult,
} from "@/github-core/mutations"
import { logger } from "@/lib/logger"

const log = logger.scope("domain:reconcileClassroom")

// The aggregate outcome of one classroom reconcile, so the caller can drive
// precise cache invalidation off which slices actually changed rather than
// blindly refetching. `skipped` is the archived-classroom short-circuit.
export type ClassroomReconcileResult = {
  skipped: boolean
  migration: TeacherMigrationResult
  description: TeamDescriptionReconcileResult
  // Staff roles this run newly created (existing teams adopt as no-ops).
  staffCreated: StaffRole[]
}

const NOOP_RESULT: ClassroomReconcileResult = {
  skipped: true,
  migration: { changed: false },
  description: { changed: false },
  staffCreated: [],
}

// Verify (and self-heal) every classroom-scoped GitHub resource a teacher/owner
// depends on, in one idempotent pass. The single home for "what a healthy
// classroom must have," so write paths (role change, roster sync, assignment
// create) no longer each re-list their own ensure* calls. Composes the existing
// idempotent primitives; every step is a no-op when already converged.
//
// Order is load-bearing: the instructor->teacher migration may create/rename the
// teacher team, so it runs BEFORE ensureStaffTeams re-affirms the staff set and
// their config-repo grants. The student-team description backfill runs last (it
// only reads classroom.json + the student team).
//
// Every call is an org-owner operation; the caller MUST gate on the viewer's
// resolved teacher role. An archived classroom short-circuits with no writes
// (returns skipped) rather than throwing — the UI hides its affordances and a
// reconcile has nothing to heal on a frozen classroom. A missing/legacy
// classroom.json reads as active (never blocks). Not wrapped in
// withGitConflictRetry here — the config-committing steps each own their retry
// and the caller wraps the whole pass — so this stays a pure composition.
export async function reconcileClassroom(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<ClassroomReconcileResult> {
  if (await isArchived(client, org, classroom)) return NOOP_RESULT

  const migration = await migrateInstructorTeamToTeacher(client, org, classroom)

  await ensureClassroomTeam(client, org, classroom)
  const { created: staffCreated } = await ensureStaffTeams(
    client,
    org,
    classroom,
  )

  const description = await reconcileStudentTeamDescription(
    client,
    org,
    classroom,
  )

  if (migration.changed || description.changed || staffCreated.length > 0) {
    log.info("classroom reconcile: healed drift", {
      org,
      classroom,
      migrationChanged: migration.changed,
      descriptionChanged: description.changed,
      staffCreated,
    })
  }

  return { skipped: false, migration, description, staffCreated }
}

// True only when classroom.json positively records active: false. A missing
// classroom.json (404, legacy) reads as active; a transient read failure
// rethrows so the caller's best-effort latch retries on a later entry rather
// than reconciling against unknown state.
async function isArchived(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<boolean> {
  try {
    return isClassroomArchived(
      await getClassroomJson(client, { org, classroom }),
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return false
    throw err
  }
}

export { NOOP_RESULT as reconcileClassroomNoopResult }
