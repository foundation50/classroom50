import type { GitHubClient } from "../client"
import {
  getBranchRef,
  getClassroomJson,
  getCommit,
  getConfigRepoBranch,
} from "../configRepoReads"
import { listTeamMembers } from "../queries"
import { prefixCommit } from "@/util/commit"
import { logger } from "@/lib/logger"
import {
  createBlob,
  createTreeFromEntries,
  createCommit,
  updateRef,
} from "./gitObjects"
import {
  ensureClassroomRoleTeam,
  grantTeamConfigRepoWrite,
  addUserToTeam,
  deleteClassroomTeam,
} from "./teams"

const log = logger.scope("mutations:teacherMigration")

// The outcome of one migration touch, so the caller can decide whether to
// invalidate caches (a committed change happened) or stay quiet (no-op).
export type TeacherMigrationResult =
  | { changed: false }
  | { changed: true; phase: "create" | "delete"; teacherSlug: string }

// Self-heal the instructor -> teacher team rename for one classroom, idempotently.
// Two phases across two touches (version-safe: an older client that still reads
// only `-instructor` never loses access mid-migration):
//
//   Phase 1 (create): a classroom recording a legacy `teams.instructor` team but
//   no `teams.teacher` gets a `classroom50-<short>-teacher` team created/adopted,
//   granted config-repo write, seeded with every instructor-team member, and
//   recorded under `teams.teacher` — leaving `-instructor` intact.
//
//   Phase 2 (delete): once `teams.teacher` is recorded AND the legacy
//   `-instructor` team is still present, the instructor team is deleted and
//   then its `teams.instructor` ref dropped (see migratePhaseDelete for the
//   ordering rationale).
//
// A classroom with neither ref (or already fully migrated) is a no-op. All GitHub
// calls are org-owner operations; a caller lacking permission should not invoke
// this (the web hook gates on the viewer's resolved teacher role).
export async function migrateInstructorTeamToTeacher(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<TeacherMigrationResult> {
  const current = await getClassroomJson(client, { org, classroom })
  const teacher = current.teams?.teacher
  const instructor = current.teams?.instructor
  const hasTeacher = Boolean(teacher?.slug)
  const hasInstructor = Boolean(instructor?.slug)

  if (!hasTeacher && hasInstructor) {
    return migratePhaseCreate(client, org, classroom, instructor!.slug)
  }
  if (hasTeacher && hasInstructor) {
    return migratePhaseDelete(client, org, classroom, teacher!, instructor!)
  }
  return { changed: false }
}

// Phase 1: ensure the teacher team, grant write, copy instructor-team members,
// and record teams.teacher in one RMW commit. Idempotent — a re-run after a
// partial failure heals (team-adopt + membership PUTs are no-ops when present).
async function migratePhaseCreate(
  client: GitHubClient,
  org: string,
  classroom: string,
  instructorSlug: string,
): Promise<TeacherMigrationResult> {
  const teacher = await ensureClassroomRoleTeam(
    client,
    org,
    classroom,
    "teacher",
  )
  await grantTeamConfigRepoWrite(client, org, teacher.slug)

  const members = await listTeamMembers(client, org, instructorSlug)
  for (const member of members) {
    await addUserToTeam(client, {
      org,
      teamSlug: teacher.slug,
      username: member.login,
      role: "maintainer",
    })
  }

  await commitTeamsPatch(client, org, classroom, (teams) => ({
    ...teams,
    teacher: { id: teacher.id, slug: teacher.slug },
  }))

  log.info("teacher migration: phase-create complete", {
    org,
    classroom,
    teacherSlug: teacher.slug,
    copied: members.length,
  })
  return { changed: true, phase: "create", teacherSlug: teacher.slug }
}

// Phase 2: delete the legacy instructor team, then drop its ref, now that the
// teacher team is recorded. When the teacher ref ADOPTED the same team as the
// instructor ref (shared slug), skip the delete and only drop the duplicate ref.
async function migratePhaseDelete(
  client: GitHubClient,
  org: string,
  classroom: string,
  teacher: { id: number; slug: string },
  instructor: { id: number; slug: string },
): Promise<TeacherMigrationResult> {
  // Delete the team BEFORE dropping the ref. deleteClassroomTeam is idempotent
  // (404 = already gone) and id-verified, so a failed delete leaves
  // teams.instructor recorded and a later touch retries Phase 2 — whereas
  // dropping the ref first would strand the team beyond any ref-based reaper if
  // the delete then failed. When the teacher ref ADOPTED the same team (shared
  // slug), skip the delete: it's the live teacher team.
  if (teacher.slug !== instructor.slug) {
    // deleteClassroomTeam is fail-closed: it refuses a ref outside the
    // classroom50- namespace or without a positive id, and verifies the live
    // team's id before deleting (see isDeletableClassroomTeamRef / TeamIdMismatch).
    await deleteClassroomTeam(client, org, instructor)
  }
  // The instructor team is gone (or was never distinct); drop the now-dangling
  // ref. A concurrent reader in the brief window between delete and this commit
  // resolves teams.instructor to a 404'd team, but Phase 1 already seeded the
  // teacher team, so combineTeacherMembership still reads the viewer via the
  // live `-teacher` probe.
  await commitTeamsPatch(client, org, classroom, (teams) => {
    const next = { ...teams }
    delete next.instructor
    return next
  })

  log.info("teacher migration: phase-delete complete", {
    org,
    classroom,
    removedSlug: instructor.slug,
  })
  return { changed: true, phase: "delete", teacherSlug: teacher.slug }
}

// Read-modify-write classroom.json applying `patch` to the `teams` object in one
// commit. Spreads `...current` so unknown/future top-level fields ride through
// verbatim (the strict CLI round-trips this file). A no-op patch still commits;
// callers gate on the phase decision above so this only runs when there's a real
// change to make.
async function commitTeamsPatch(
  client: GitHubClient,
  org: string,
  classroom: string,
  patch: (teams: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const configBranch = await getConfigRepoBranch(client, org)
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)
  const current = (await getClassroomJson(client, {
    org,
    classroom,
    ref: ref.object.sha,
  })) as unknown as Record<string, unknown>

  const currentTeams = (current.teams ?? {}) as Record<string, unknown>
  const nextTeams = patch(currentTeams)
  const next = { ...current, teams: nextTeams }

  const blob = await createBlob(client, {
    org,
    content: JSON.stringify(next, null, 2) + "\n",
  })
  const tree = await createTreeFromEntries(client, {
    org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: `${classroom}/classroom.json`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      },
    ],
  })
  const newCommit = await createCommit(client, {
    org,
    message: prefixCommit(
      `Migrate instructor team to teacher for ${classroom}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
    classroom,
  })
  await updateRef(client, org, newCommit.sha, configBranch)
}
