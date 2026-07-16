import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  isActiveMember,
  updateRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "../classrooms"
import { getRawFileWithFallbackSource, getUser } from "@/github-core/queries"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { prefixCommit } from "@/util/commit"
import {
  normalizeStudentRow,
  splitName,
  parseStudentsCsv,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "@/util/rosterCsv"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { type ClassroomRole } from "@/util/teamRoster"
import {
  log,
  rosterWriteTree,
  resolveClassroomTeamSlug,
  tryAddUserToTeam,
  normalizeGithubUsername,
  isLikelyGithubUsername,
  NoNewStudentsError,
} from "./rosterPrimitives"

type BulkImportProgress = {
  processed: number
  total: number
  message: string
}

// A parsed roster-upload row. Only username is required; the rest is optional
// metadata. github_id is intentionally NOT taken from the file — it's re-derived
// from GitHub so the stored id is always authoritative.
export type ImportRosterRow = {
  username: string
  first_name?: string
  last_name?: string
  email?: string
  section?: string
  // Classroom role from an optional `role` column, validated to a ClassroomRole.
  // Undefined when absent or unrecognized; the upload defaults it to "student"
  // and lets the instructor override per row before inviting.
  role?: ClassroomRole
}

export type AddStudentsToClassroomInput = {
  org: string
  classroom: string
  // Full metadata rows (preferred). When omitted, `usernames` is used as
  // username-only rows. Exactly one should be provided.
  rows?: ImportRosterRow[]
  usernames?: string[]
  onProgress?: (progress: BulkImportProgress) => void
}

export type AddStudentsToClassroomResult = CreateClassroomResult & {
  addedStudents: StudentCsvRow[]
  skippedStudents: {
    username: string
    reason: "duplicate" | "not_found" | "invalid" | "error"
    message?: string
  }[]
}

export async function addStudentsToClassroom(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
): Promise<AddStudentsToClassroomResult> {
  // Unify rows/usernames into metadata rows, deduped by lowercased username
  // (first occurrence wins, so its metadata is kept).
  const rawRows: ImportRosterRow[] =
    input.rows ?? (input.usernames ?? []).map((username) => ({ username }))
  const normalizedRows = Array.from(
    new Map(
      rawRows
        .map((row) => ({
          ...row,
          username: normalizeGithubUsername(row.username),
        }))
        .filter((row) => row.username)
        .map((row) => [row.username.toLowerCase(), row]),
    ).values(),
  )

  if (normalizedRows.length === 0) {
    throw new Error("At least one GitHub username is required")
  }

  log.info("bulk add students: started", {
    org: input.org,
    classroom: input.classroom,
    total: normalizedRows.length,
  })

  await assertClassroomNotArchived(client, input.org, input.classroom)

  input.onProgress?.({
    processed: 0,
    total: normalizedRows.length,
    message: "Reading current roster.csv...",
  })

  const configBranch = await getConfigRepoBranch(client, input.org)
  const ref = await getBranchRef(client, input.org, configBranch)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = rosterPath(input.classroom)

  const currentCsv = await getRawFileWithFallbackSource(client, {
    org: input.org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(input.classroom),
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv.content)

  const existingUsernameKeys = new Set(
    currentStudents.map((student) => student.username.toLowerCase()),
  )

  const existingGithubIds = new Set(
    currentStudents.map((student) => student.github_id).filter(Boolean),
  )

  const skippedStudents: AddStudentsToClassroomResult["skippedStudents"] = []
  const addedStudents: StudentCsvRow[] = []

  let processed = 0

  for (const row of normalizedRows) {
    const username = row.username
    input.onProgress?.({
      processed,
      total: normalizedRows.length,
      message: `Checking ${username}...`,
    })

    if (!isLikelyGithubUsername(username)) {
      skippedStudents.push({
        username,
        reason: "invalid",
        message: "Invalid GitHub username",
      })

      processed++
      continue
    }

    // Dedupe by login (pre-resolution). Dedupe by github_id happens after the
    // GitHub lookup, since the file may store a stale/renamed login.
    if (existingUsernameKeys.has(username.toLowerCase())) {
      skippedStudents.push({
        username,
        reason: "duplicate",
        message: "Student is already in roster.csv",
      })

      processed++
      continue
    }

    try {
      const githubUser = await getUser(client, username)

      if (existingGithubIds.has(String(githubUser.id))) {
        skippedStudents.push({
          username: githubUser.login,
          reason: "duplicate",
          message: "Student GitHub ID is already in roster.csv",
        })

        processed++
        continue
      }

      // Metadata: prefer the uploaded row, fall back to the GitHub profile.
      const nameParts = splitName(githubUser.name)
      const first_name = row.first_name?.trim() || nameParts.first_name
      const last_name = row.last_name?.trim() || nameParts.last_name
      const email = row.email?.trim() || githubUser.email || ""

      const student = normalizeStudentRow({
        username: githubUser.login,
        first_name,
        last_name,
        email,
        section: row.section?.trim() ?? "",
        github_id: String(githubUser.id),
      })

      existingUsernameKeys.add(student.username.toLowerCase())
      existingGithubIds.add(student.github_id)
      addedStudents.push(student)
    } catch (err) {
      log.debug("bulk add: user lookup failed, skipping row", {
        username,
        err,
      })
      skippedStudents.push({
        username,
        reason: "not_found",
        message:
          err instanceof Error ? err.message : "Could not fetch GitHub user",
      })
    }

    processed++

    input.onProgress?.({
      processed,
      total: normalizedRows.length,
      message: `Checked ${processed} of ${normalizedRows.length} usernames...`,
    })
  }

  if (addedStudents.length === 0) {
    throw new NoNewStudentsError()
  }

  input.onProgress?.({
    processed,
    total: normalizedRows.length,
    message: "Writing roster.csv...",
  })

  const nextStudents = [...currentStudents, ...addedStudents]
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: rosterWriteTree(input.classroom, nextCsv, currentCsv.fromLegacy),
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Add ${addedStudents.length} student ${
        addedStudents.length === 1 ? "" : "s"
      }: ${input.classroom}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(
    client,
    input.org,
    newCommit.sha,
    configBranch,
  )

  input.onProgress?.({
    processed: normalizedRows.length,
    total: normalizedRows.length,
    message: "roster.csv updated.",
  })

  log.info("bulk add students: completed", {
    org: input.org,
    classroom: input.classroom,
    added: addedStudents.length,
    skipped: skippedStudents.length,
  })

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    addedStudents,
    skippedStudents,
  }
}

export async function addStudentsToClassroomWithConflictRetry(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
) {
  return withGitConflictRetry(() => addStudentsToClassroom(client, input))
}

export type BulkEnrollStudentsResult = AddStudentsToClassroomResult & {
  teamResults: {
    username: string
    status: "added" | "failed"
    message?: string
  }[]
}

export type BulkImportResult = {
  addedStudents: StudentCsvRow[]
  skippedStudents: {
    username: string
    reason: "duplicate" | "not_found" | "invalid" | "error"
    message?: string
  }[]
  teamResults?: {
    username: string
    status: "added" | "failed"
    message?: string
  }[]
}
export async function bulkEnrollStudentsInClassroom(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
): Promise<BulkEnrollStudentsResult> {
  const { onProgress, ...bulkInput } = input

  await assertClassroomNotArchived(client, bulkInput.org, bulkInput.classroom)

  const total = (bulkInput.rows ?? bulkInput.usernames ?? []).length

  log.info("bulk enroll: started", {
    org: bulkInput.org,
    classroom: bulkInput.classroom,
    total,
  })

  onProgress?.({
    processed: 0,
    total,
    message: "Reading classroom roster...",
  })

  // Retry on conflict: a concurrent commit during the slow bulk window would
  // 409 and discard the whole import. Re-reading is safe — adds are append-only.
  const addResult = await addStudentsToClassroomWithConflictRetry(client, {
    ...bulkInput,
    onProgress,
  })

  // Roster commit already landed. A transient slug-read failure becomes a
  // per-student team failure rather than rejecting the whole bulk enroll.
  let teamSlug: string | undefined
  let teamSlugError: string | undefined
  try {
    teamSlug = await resolveClassroomTeamSlug(
      client,
      bulkInput.org,
      bulkInput.classroom,
    )
  } catch (err) {
    log.warn("bulk enroll: classroom team read failed, team adds will defer", {
      org: bulkInput.org,
      classroom: bulkInput.classroom,
      err,
    })
    teamSlugError = getErrorMessage(err)
  }

  const teamResults: BulkImportResult["teamResults"] = []

  for (let i = 0; i < addResult.addedStudents.length; i++) {
    const student = addResult.addedStudents[i]

    onProgress?.({
      processed: i,
      total: addResult.addedStudents.length,
      message: `Verifying ${student.username} in the organization...`,
    })

    // Verify by team membership through org membership: only an active org
    // member is team-added (the trust model used across the enroll paths). A
    // non-member is skipped here — they need an org invite first (sent by the
    // upload's invite pass), so there's nothing to team-add yet.
    if (!(await isActiveMember(client, bulkInput.org, student.username))) {
      onProgress?.({
        processed: i + 1,
        total: addResult.addedStudents.length,
        message: `Processed ${i + 1} of ${addResult.addedStudents.length}...`,
      })
      continue
    }

    if (teamSlug === undefined) {
      teamResults.push({
        username: student.username,
        status: "failed",
        message:
          `Could not read the classroom team to add the student` +
          (teamSlugError ? ` (${teamSlugError})` : "") +
          "; retry to add them to the team.",
      })

      onProgress?.({
        processed: i + 1,
        total: addResult.addedStudents.length,
        message: `Processed ${i + 1} of ${addResult.addedStudents.length} team memberships...`,
      })
      continue
    }

    const added = await tryAddUserToTeam(
      client,
      { org: bulkInput.org, teamSlug, username: student.username },
      "bulk enroll",
    )
    teamResults.push(
      added.ok
        ? { username: student.username, status: "added" }
        : {
            username: student.username,
            status: "failed",
            message: added.detail || "Could not add user to classroom team",
          },
    )

    onProgress?.({
      processed: i + 1,
      total: addResult.addedStudents.length,
      message: `Processed ${i + 1} of ${addResult.addedStudents.length} team memberships...`,
    })
  }

  onProgress?.({
    processed: total,
    total,
    message: "Import complete",
  })

  log.info("bulk enroll: completed", {
    org: bulkInput.org,
    classroom: bulkInput.classroom,
    added: addResult.addedStudents.length,
    skipped: addResult.skippedStudents.length,
    teamFailed: teamResults.filter((r) => r.status === "failed").length,
  })

  return {
    ...addResult,
    teamResults,
  }
}
