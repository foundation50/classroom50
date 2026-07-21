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

// Aggregate outcome so the caller invalidates only the slices that changed;
// `skipped` marks the archived short-circuit.
export type ClassroomReconcileResult = {
  skipped: boolean
  migration: TeacherMigrationResult
  description: TeamDescriptionReconcileResult
  // Staff roles this run newly created (existing teams adopt as no-ops).
  staffCreated: StaffRole[]
}

// A 404 on the student-team read (a derived/wrong slug that never converges) is
// the one hopeless failure a reconcile can't retry away; every other 404 in the
// pass (a propagating commit, a just-deleted instructor team) is transient. This
// distinct type lets the caller latch only the former so a blip doesn't disable
// the whole classroom heal for the mount.
export class ClassroomReconcilePermanentError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super("classroom reconcile hit a permanently unconvergeable state")
    this.name = "ClassroomReconcilePermanentError"
    this.cause = cause
  }
}

const NOOP_RESULT: ClassroomReconcileResult = {
  skipped: true,
  migration: { changed: false },
  description: { changed: false },
  staffCreated: [],
}

// Verify (and self-heal) every classroom-scoped GitHub resource a teacher/owner
// depends on, in one idempotent pass, composing the existing primitives.
//
// Order is load-bearing: the instructor->teacher migration may create the
// teacher team, so it runs BEFORE ensureStaffTeams re-affirms the staff set.
// Every call is an org-owner op; the caller MUST gate on the teacher role. An
// archived classroom short-circuits with no writes (returns skipped); a
// missing/legacy classroom.json reads as active.
export async function reconcileClassroom(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<ClassroomReconcileResult> {
  if (await isArchived(client, org, classroom)) return NOOP_RESULT

  // Legacy instructor->teacher team rename. This is the ONLY web call site of
  // the migration — remove it here (with teacherMigration.ts) when #322 drops
  // the instructor alias after the deprecation window.
  const migration = await migrateInstructorTeamToTeacher(client, org, classroom)

  const { created: studentTeamCreated } = await ensureClassroomTeam(
    client,
    org,
    classroom,
  )
  const { created: staffCreated } = await ensureStaffTeams(
    client,
    org,
    classroom,
  )

  // A 404 from the student-team read is permanent (a wrong derived slug never
  // converges) UNLESS we just created that team this pass: then it's a
  // create->read replication blip, transient, so leave it a plain 404 and let a
  // later entry retry rather than latching the whole heal off for the mount.
  let description: TeamDescriptionReconcileResult
  try {
    description = await reconcileStudentTeamDescription(client, org, classroom)
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      err.isNotFound &&
      !studentTeamCreated
    ) {
      throw new ClassroomReconcilePermanentError(err)
    }
    throw err
  }

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
// rethrows so the caller's latch retries rather than reconciling blind.
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
