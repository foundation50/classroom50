import type { GitHubClient } from "@/github-core/client"
import { getClassroomJson } from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import { isClassroomArchived, type StaffRole } from "@/types/classroom"
import {
  ensureClassroomTeam,
  ensureStaffTeams,
  migrateInstructorTeamToTeacher,
  reconcileStudentTeamDescription,
  removeUserFromTeam,
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
//
// `creator` (the acting owner) is dropped from the student/hta/ta teams this
// pass touches, never teacher: the create POST silently adds the owner as a
// maintainer of every team it makes, and an owner sitting on those teams is the
// mixed-role state the roster would miscount. The drop is unconditional (not
// gated on created-vs-adopted) so a pre-existing stray membership self-heals —
// mirrors createClassroomFiles' dropCreatorFromNonTeacherTeams.
export async function reconcileClassroom(
  client: GitHubClient,
  org: string,
  classroom: string,
  creator?: string,
): Promise<ClassroomReconcileResult> {
  if (await isArchived(client, org, classroom)) return NOOP_RESULT

  // Legacy instructor->teacher team rename. This is the ONLY web call site of
  // the migration — remove it here (with teacherMigration.ts) when #322 drops
  // the instructor alias after the deprecation window.
  const migration = await migrateInstructorTeamToTeacher(client, org, classroom)

  const { slug: studentTeamSlug, created: studentTeamCreated } =
    await ensureClassroomTeam(client, org, classroom)
  const { teams: staffTeams, created: staffCreated } = await ensureStaffTeams(
    client,
    org,
    classroom,
  )

  // Clear the owner off every non-teacher team we just touched. Best-effort and
  // idempotent (404 = already absent); a failure leaves them on a team where the
  // roster's per-role badge surfaces it, so it must not abort the heal.
  await dropCreatorFromNonTeacherTeams(client, org, creator, [
    studentTeamSlug,
    staffTeams.hta?.slug,
    staffTeams.ta?.slug,
  ])

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

// Drop the acting owner from the given non-teacher team slugs (never teacher).
// Skips when no creator is known. Best-effort per team: removeUserFromTeam is
// idempotent (404 = already absent) and swallows failures, so a hiccup can't
// abort the classroom heal.
async function dropCreatorFromNonTeacherTeams(
  client: GitHubClient,
  org: string,
  creator: string | undefined,
  slugs: ReadonlyArray<string | undefined>,
): Promise<void> {
  if (!creator) return
  for (const teamSlug of slugs) {
    if (!teamSlug) continue
    try {
      await removeUserFromTeam(client, { org, teamSlug, username: creator })
    } catch {
      log.warn("classroom reconcile: dropping creator from team failed", {
        org,
        creator,
        teamSlug,
      })
    }
  }
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
