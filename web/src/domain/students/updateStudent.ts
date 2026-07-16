import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "../classrooms"
import { getRawFileWithFallbackSource } from "@/github-core/queries"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { studentKey } from "@/util/identity"
import { prefixCommit } from "@/util/commit"
import {
  normalizeStudentRow,
  parseStudentsCsv,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "@/util/rosterCsv"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { rosterWriteTree } from "./rosterPrimitives"

// The teacher-editable subset of a roster row. Identity columns (username,
// github_id) are deliberately excluded — they are bound at enrollment and by
// the team-driven roster, not hand-edited here.
export type StudentEditableFields = {
  first_name: string
  last_name: string
  email: string
  section: string
}

export type UpdateStudentInput = {
  org: string
  classroom: string
  // Stable identity of the target row (github_id, else username, else email),
  // captured BEFORE the edit. The edit never changes these keys, so the row is
  // still findable after the rewrite.
  key: string
  patch: StudentEditableFields
  // Identity columns for the row, used to CREATE it when no roster.csv row
  // matches `key` yet — a team member (e.g. a staff instructor/TA) added on
  // GitHub whose blank metadata row hasn't been written by syncRosterFromTeam.
  // Editing then upserts rather than failing. Omitted -> a missing key is an
  // error (the legacy strict behavior, for callers that guarantee the row).
  identity?: { github_id?: string; username?: string; email?: string }
}

export type UpdateStudentResult = CreateClassroomResult & {
  student: StudentCsvRow
}

// Edit one roster row's teacher-facing fields in place and commit the rewritten
// roster.csv. Identity columns are preserved verbatim from the matched row.
export async function updateStudent(
  client: GitHubClient,
  input: UpdateStudentInput,
): Promise<UpdateStudentResult> {
  const { org, classroom, key, patch, identity } = input

  const targetKey = key.trim()
  if (!targetKey) {
    throw new Error("A student row identity is required")
  }

  await assertClassroomNotArchived(client, org, classroom)

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

  // Stable per-row identity via the shared studentKey (github_id -> username ->
  // email), the same precedence the UI and reconcile use.
  let targetIndex = currentStudents.findIndex(
    (row) => studentKey(row) === targetKey,
  )

  // Before treating a miss as an upsert, re-resolve by the FULL identity claim
  // (github_id OR case-insensitive username), not just the studentKey. A person
  // can have a legacy username-only (id-less) row while the edit is keyed by
  // github_id (buildTeamRoster stamps an enrolled row's id from the live GitHub
  // member): those keys differ, so a studentKey-only match would miss and append
  // a DUPLICATE. Matching the claim set edits the existing row instead — the
  // same id+login dedup syncRosterFromTeam uses.
  if (targetIndex === -1 && identity) {
    const idKey = identity.github_id?.trim()
    const loginKey = identity.username?.trim().toLowerCase()
    targetIndex = currentStudents.findIndex(
      (row) =>
        (Boolean(idKey) && row.github_id.trim() === idKey) ||
        (Boolean(loginKey) && row.username.trim().toLowerCase() === loginKey),
    )
  }

  // No matching row (even by claim): upsert when identity is provided (see the
  // `identity` field doc), else preserve the strict error.
  const missing = targetIndex === -1
  if (missing && !identity) {
    throw new Error(`Student does not exist in roster: ${targetKey}`)
  }

  const nextEmail = patch.email.trim()

  // Every roster row now carries a GitHub identity, so its email is metadata
  // and freely editable — the row is keyed by github_id/username, never email.

  // Guard against editing an email into one already held by ANOTHER row
  // (case-insensitive). On an upsert (missing, targetIndex -1) there is no self
  // row, so every match is a genuine clash.
  if (nextEmail) {
    const emailKey = nextEmail.toLowerCase()
    const clash = currentStudents.some(
      (row, idx) => idx !== targetIndex && row.email.toLowerCase() === emailKey,
    )
    if (clash) {
      throw new Error(`Email already used by another student: ${nextEmail}`)
    }
  }

  // Spread the existing row (preserving identity columns) or seed a new row from
  // the passed identity on an upsert, then overwrite only the editable fields.
  const updatedStudent = normalizeStudentRow({
    ...(missing ? (identity ?? {}) : currentStudents[targetIndex]),
    first_name: patch.first_name,
    last_name: patch.last_name,
    email: nextEmail,
    section: patch.section,
  })

  const nextStudents = missing
    ? [...currentStudents, updatedStudent]
    : currentStudents.map((row, idx) =>
        idx === targetIndex ? updatedStudent : row,
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
      `Edit student: ${classroom}/${updatedStudent.username || updatedStudent.email || targetKey}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha, configBranch)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    student: updatedStudent,
  }
}

export async function updateStudentWithConflictRetry(
  client: GitHubClient,
  input: UpdateStudentInput,
) {
  return withGitConflictRetry(() => updateStudent(client, input))
}
