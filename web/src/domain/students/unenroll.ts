import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  getOrgMembershipState,
  removeUserFromTeam,
  updateRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"
import { getRawFileWithFallbackSource } from "@/github-core/queries"
import { getAuthenticatedUser } from "@/domain/queries/users"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { isSameGitHubUser } from "@/util/students"
import { prefixCommit } from "@/util/commit"
import {
  parseStudentsCsv,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "@/util/rosterCsv"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { type Student } from "@/types/classroom"
import {
  log,
  rosterWriteTree,
  resolveClassroomTeamSlug,
  cancelSoleClassroomInviteOnUnenroll,
  matchesRosterRow,
} from "./rosterPrimitives"

export type UnenrollStudentInput = {
  org: string
  classroom: string
  student: Student
}
export async function unenrollStudent(
  client: GitHubClient,
  input: UnenrollStudentInput,
) {
  const { org, classroom, student: toRemoveStudent } = input
  log.info("unenroll student: started", { org, classroom })
  await assertClassroomNotArchived(client, org, classroom)
  const normalizedUsername = toRemoveStudent?.username.trim()
  const normalizedEmail = toRemoveStudent?.email?.trim()

  // An email-invited row not yet claimed has no username, so accept email too.
  // One of the two must be present to target a row.
  if (!normalizedUsername && !normalizedEmail) {
    throw new Error("Student's GitHub username or email is required")
  }

  // Resolve the slug concurrently with the commit. Can reject on a transient
  // read; attach a catch and consume it in the warning path below.
  const teamSlugPromise = resolveClassroomTeamSlug(client, org, classroom)
  teamSlugPromise.catch(() => {})

  // Read org state and viewer before the commit. State is null on read failure
  // (then we skip the org action). The viewer guards against removing the
  // signed-in teacher. An email-only row has no username to resolve state for.
  const orgStatePromise = normalizedUsername
    ? getOrgMembershipState(client, org, normalizedUsername)
    : Promise.resolve(null)
  orgStatePromise.catch(() => {})
  const viewerPromise = getAuthenticatedUser(client)
  viewerPromise.catch(() => {})

  const configBranch = await getConfigRepoBranch(client, org)
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)

  const studentsFilePath = rosterPath(classroom)

  const currentCsv = await getRawFileWithFallbackSource(client, {
    org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(classroom),
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv.content)

  // Match the target row via the shared roster-row matcher (username/github_id).
  const sameRow = (student: StudentCsvRow) =>
    matchesRosterRow(student, toRemoveStudent)

  const exists = currentStudents.some(sameRow)

  if (!exists) {
    throw new Error(
      `Student ${toRemoveStudent.username || normalizedEmail} does not exist in roster!`,
    )
  }

  const nextStudents = currentStudents.filter((student) => !sameRow(student))
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org,
    base_tree: commit.tree.sha,
    tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Remove student: ${classroom}/${toRemoveStudent.username || normalizedEmail}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha, configBranch)

  // Commit landed, so every org-side step below is a non-fatal warning.
  const warnings: string[] = []

  // Drop from the classroom team. Idempotent (404 = not a member / team gone);
  // org membership untouched. Skipped for an email-only row.
  if (normalizedUsername) {
    try {
      const teamSlug = await teamSlugPromise
      await removeUserFromTeam(client, {
        org,
        teamSlug,
        username: normalizedUsername,
      })
    } catch (err) {
      log.error("team removal failed (student unenrolled)", { err })
      const detail = getErrorMessage(err)
      warnings.push(
        `${toRemoveStudent.username} was removed from the roster, but removing ` +
          `them from the classroom team failed (${detail}); they may keep read on ` +
          `private templates until it's retried.`,
      )
    }
  }

  // Cancel the pending invite only when it belongs solely to this classroom
  // (see resolveClassroomPendingInvite); a multi-classroom invite is left intact
  // so a sibling classroom's onboarding survives. An ACTIVE member is never
  // touched — unenroll is classroom-scoped; org removal lives on the Members
  // page. Resolve defensively: a reject after the commit landed would break the
  // "commit landed -> non-fatal warning" guarantee.
  const orgState = await orgStatePromise.catch(() => null)

  // Never cancel the signed-in teacher's own invite (a teacher mid-enrollment).
  const viewer = await viewerPromise.catch(() => null)
  const isSelf = isSameGitHubUser(viewer, toRemoveStudent)

  const shouldCancelInvite = orgState === "pending"

  if (shouldCancelInvite && isSelf) {
    warnings.push(
      `${toRemoveStudent.username} was removed from the roster. Their ` +
        `pending organization invite was kept because they are the signed-in ` +
        `account.`,
    )
  } else if (shouldCancelInvite) {
    const teamSlug = await teamSlugPromise.catch(() => undefined)
    warnings.push(
      ...(await cancelSoleClassroomInviteOnUnenroll(client, {
        org,
        classroom,
        username: normalizedUsername,
        displayName: toRemoveStudent.username,
        teamSlug,
        logContext: "org invite cancellation failed (student unenrolled)",
      })),
    )
  }

  log.info("unenroll student: completed", {
    org,
    classroom,
    warnings: warnings.length,
  })
  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    teamWarning: warnings.length > 0 ? warnings.join(" ") : undefined,
  }
}

export type BulkUnenrollProgress = {
  processed: number
  total: number
  message: string
}

export type BulkUnenrollStudentsInput = {
  org: string
  classroom: string
  students: Student[]
  onProgress?: (progress: BulkUnenrollProgress) => void
}

export type BulkUnenrollStudentsResult = {
  // Students whose roster row was dropped in the single CSV commit.
  removed: Student[]
  // Students whose row wasn't found in the CSV (already gone) — no-op, not an error.
  notFound: Student[]
  // Per-student non-fatal side-effect failures (team drop / invite cancel).
  warnings: string[]
  // The single roster commit's sha (undefined when nothing matched).
  newCommitSha?: string
}

// Remove MANY students from one classroom in a SINGLE roster commit, then run
// the per-student org-side side effects (team drop + pending-invite cancel)
// best-effort. The batch form of unenrollStudent: looping that per student
// would produce one commit PER student (N noisy commits racing the same ref),
// whereas real classes are unenrolled in bulk. Mirrors
// bulkEnrollStudentsInClassroom / addStudentsToClassroom (one commit for all).
//
// The CSV rewrite is conflict-retried and re-reads inside the closure, so a
// concurrent edit can't be clobbered. Org-side steps run only AFTER the commit
// lands, so — as in unenrollStudent — they are non-fatal warnings. Active
// members are never removed from the org here (unenroll is classroom-scoped);
// only a still-PENDING invite is cancelled, and never the signed-in teacher's.
export async function bulkUnenrollStudents(
  client: GitHubClient,
  input: BulkUnenrollStudentsInput,
): Promise<BulkUnenrollStudentsResult> {
  const { org, classroom, students, onProgress } = input
  await assertClassroomNotArchived(client, org, classroom)

  const targets = students.filter(
    (s) => s.username?.trim() || s.email?.trim() || s.github_id?.trim(),
  )
  if (targets.length === 0) {
    return { removed: [], notFound: [], warnings: [] }
  }

  log.info("bulk unenroll: started", { org, classroom, total: targets.length })

  // Same per-row match predicate as unenrollStudent (shared matchesRosterRow):
  // username/github_id.
  const matchesTarget = (row: StudentCsvRow, target: Student): boolean =>
    matchesRosterRow(row, target)

  // Resolve slug + viewer once, concurrently with the commit.
  const teamSlugPromise = resolveClassroomTeamSlug(client, org, classroom)
  teamSlugPromise.catch(() => {})
  const viewerPromise = getAuthenticatedUser(client)
  viewerPromise.catch(() => {})

  onProgress?.({
    processed: 0,
    total: targets.length,
    message: "Updating classroom roster...",
  })

  // One conflict-retried CSV commit dropping every matched row. Re-reads the CSV
  // each attempt so a concurrent edit is preserved. Reports which targets were
  // actually present (removed) vs. missing (notFound).
  const studentsFilePath = rosterPath(classroom)
  let removed: Student[] = []
  let notFound: Student[] = []
  let newCommitSha: string | undefined

  await withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)
    const currentCsv = await getRawFileWithFallbackSource(client, {
      org,
      path: studentsFilePath,
      fallbackPath: legacyRosterPath(classroom),
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv.content)

    removed = targets.filter((target) =>
      currentStudents.some((row) => matchesTarget(row, target)),
    )
    notFound = targets.filter((target) => !removed.includes(target))

    if (removed.length === 0) {
      // Nothing to drop (all already gone) — skip the commit entirely.
      newCommitSha = undefined
      return
    }

    const nextStudents = currentStudents.filter(
      (row) => !removed.some((target) => matchesTarget(row, target)),
    )
    const nextCsv = stringifyStudentsCsv(nextStudents)

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Remove ${removed.length} student${removed.length === 1 ? "" : "s"}: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, configBranch)
    newCommitSha = newCommit.sha
  })

  // Roster commit landed; every org-side step below is a non-fatal warning.
  const warnings: string[] = []
  const viewer = await viewerPromise.catch(() => null)
  let teamSlug: string | undefined
  try {
    teamSlug = await teamSlugPromise
  } catch (err) {
    log.warn("bulk unenroll: classroom team read failed, skipping team drops", {
      org,
      classroom,
      err,
    })
    teamSlug = undefined
  }

  for (let i = 0; i < removed.length; i++) {
    const student = removed[i]
    const username = student.username?.trim()
    onProgress?.({
      processed: i,
      total: removed.length,
      message: `Updating team membership for ${username || student.email || "student"}...`,
    })

    // Drop from the classroom team (idempotent). Skipped for an email-only row
    // and when the slug couldn't be resolved.
    if (username && teamSlug) {
      try {
        await removeUserFromTeam(client, { org, teamSlug, username })
      } catch (err) {
        log.error("team removal failed (student bulk-unenrolled)", { err })
        warnings.push(
          `${username} was removed from the roster, but removing them from the ` +
            `classroom team failed (${getErrorMessage(err)}); they may keep read ` +
            `on private templates until it's retried.`,
        )
      }
    }

    // Cancel a still-pending invite only when it belongs solely to this
    // classroom (never an active member; never self). A multi-classroom invite
    // is left intact — the team drop above is the classroom-scoped effect.
    if (username) {
      const orgState = await getOrgMembershipState(client, org, username).catch(
        () => null,
      )
      if (orgState === "pending" && !isSameGitHubUser(viewer, student)) {
        warnings.push(
          ...(await cancelSoleClassroomInviteOnUnenroll(client, {
            org,
            classroom,
            username,
            teamSlug,
            logContext:
              "org invite cancellation failed (student bulk-unenrolled)",
          })),
        )
      } else if (orgState === "pending" && isSameGitHubUser(viewer, student)) {
        warnings.push(
          `${username} was removed from the roster. Their pending organization ` +
            `invite was kept because they are the signed-in account.`,
        )
      }
    }
  }

  onProgress?.({
    processed: removed.length,
    total: removed.length,
    message: "Done",
  })

  log.info("bulk unenroll: completed", {
    org,
    classroom,
    removed: removed.length,
    notFound: notFound.length,
    warnings: warnings.length,
  })

  return { removed, notFound, warnings, newCommitSha }
}
