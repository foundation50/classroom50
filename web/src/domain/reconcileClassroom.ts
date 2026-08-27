import type { GitHubClient } from "@/github-core/client"
import { getClassroomJson } from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import {
  isClassroomArchived,
  type Classroom,
  type StaffRole,
} from "@/types/classroom"
import {
  ensureClassroomTeam,
  ensureStaffTeams,
  grantStaffTeamsConfigRepoAccess,
  projectTeamDescriptionFromRecord,
  reconcileStudentTeamDescription,
  removeUserFromTeam,
  type TeamDescriptionReconcileResult,
} from "@/github-core/mutations"
import { reconcileRoster } from "./students/reconcileRoster"
import { logger } from "@/lib/logger"

const log = logger.scope("domain:reconcileClassroom")

// Aggregate outcome so the caller invalidates only the slices that changed;
// `skipped` marks the archived short-circuit.
export type ClassroomReconcileResult = {
  skipped: boolean
  description: TeamDescriptionReconcileResult
  // Staff roles this run newly created (existing teams adopt as no-ops).
  staffCreated: StaffRole[]
  // Invited emails recovered from per-invite metadata teams and folded into
  // roster.csv this pass (their teams were then deleted). Empty when none.
  invitesBackfilled: string[]
  // The consolidated roster reconciliation committed a change (recovered
  // fold, dead-row removal, member append, or role/id refresh).
  rosterChanged: boolean
}

// A 404 on the student-team read (a derived/wrong slug that never converges) is
// the one hopeless failure a reconcile can't retry away; every other 404 in the
// pass (a propagating commit) is transient. This
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
  description: { changed: false },
  staffCreated: [],
  invitesBackfilled: [],
  rosterChanged: false,
}

// An archived classroom skips the team/roster writes, but its team-description
// projection must still converge: the classroom50/team/v1 record has to
// advertise active: false (and the final name/term), and this is the only heal
// when the best-effort projection inside editClassroom failed during the
// archive/edit itself. Projected from the record the archived gate already
// read — never a re-fetch.
async function reconcileArchivedClassroom(
  client: GitHubClient,
  org: string,
  classroom: string,
  record: Classroom,
): Promise<ClassroomReconcileResult> {
  let description: TeamDescriptionReconcileResult
  try {
    description = await projectTeamDescriptionFromRecord(
      client,
      org,
      classroom,
      record,
    )
  } catch (err) {
    // This path never creates the student team, so a team-read 404 is a wrong
    // or deleted slug that never converges — latch it (mirrors the active
    // path); everything else stays transient for a later retry.
    if (err instanceof GitHubAPIError && err.isNotFound) {
      throw new ClassroomReconcilePermanentError(err)
    }
    throw err
  }
  return { ...NOOP_RESULT, description }
} // Verify (and self-heal) every classroom-scoped GitHub resource a teacher/owner
// depends on, in one idempotent pass, composing the existing primitives.
//
// Every call is an org-owner op; the caller MUST gate on the teacher role. An
// archived classroom skips the team/roster writes (returns skipped) but still
// converges its team-description projection; a missing/legacy classroom.json
// reads as active.
//
// `creator` (the acting owner) is dropped from the student/hta/ta teams this
// pass touches, never teacher: the create POST silently adds the owner as a
// maintainer of every team it makes, and an owner sitting on those teams is the
// mixed-role state the roster would miscount. The drop is unconditional (not
// gated on created-vs-adopted) so a pre-existing stray membership self-heals —
// mirrors createClassroomFiles' inline creator drop (and the CLI's
// dropCreatorFromNonTeacherTeams).
export async function reconcileClassroom(
  client: GitHubClient,
  org: string,
  classroom: string,
  creator?: string,
): Promise<ClassroomReconcileResult> {
  const archivedRecord = await readArchivedRecord(client, org, classroom)
  if (archivedRecord) {
    return reconcileArchivedClassroom(client, org, classroom, archivedRecord)
  }

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

  // Grant staff-team config-repo access AFTER the drop (order is load-bearing —
  // see ensureStaffTeams); also re-affirms the TA read-only downgrade.
  // Best-effort: a failure leaves access unset until the next pass, never aborts
  // the heal.
  try {
    await grantStaffTeamsConfigRepoAccess(client, org, staffTeams)
  } catch (err) {
    log.warn(
      "classroom reconcile: granting staff-team config-repo access failed",
      {
        org,
        classroom,
        err,
      },
    )
  }

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

  // The consolidated roster reconciliation: recover accepted email invites,
  // drop dead email-only rows, and sync identity/role rows from the teams — at
  // most one commit (see reconcileRoster). Best-effort here: unlike the
  // never-throw collect half, the sync half can throw (a transient write
  // failure), and that must not latch the classroom heal off.
  let rosterChanged = false
  let invitesBackfilled: string[] = []
  try {
    const roster = await reconcileRoster(client, { org, classroom })
    rosterChanged = !roster.noop
    invitesBackfilled = roster.recoveredEmails
  } catch (err) {
    log.warn("classroom reconcile: roster reconciliation failed", {
      org,
      classroom,
      err,
    })
  }

  if (description.changed || staffCreated.length > 0 || rosterChanged) {
    log.info("classroom reconcile: healed drift", {
      org,
      classroom,
      descriptionChanged: description.changed,
      staffCreated,
      rosterChanged,
      invitesBackfilled: invitesBackfilled.length,
    })
  }

  return {
    skipped: false,
    description,
    staffCreated,
    invitesBackfilled,
    rosterChanged,
  }
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

// The classroom.json record when the classroom positively records
// active: false, else null. A missing classroom.json (404, legacy) reads as
// active; a transient read failure rethrows so the caller's latch retries
// rather than reconciling blind.
async function readArchivedRecord(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<Classroom | null> {
  try {
    const record = await getClassroomJson(client, { org, classroom })
    return isClassroomArchived(record) ? record : null
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return null
    throw err
  }
}
