import Papa from "papaparse"
import type { GitHubClient } from "@/hooks/github/client"
import {
  addUserToTeam,
  createGitCommit,
  createGitTree,
  createOrgInvitation,
  ensureOrgMembership,
  getErrorMessage,
  getOrgMembershipState,
  isActiveMember,
  removeOrgMembership,
  removeUserFromTeam,
  updateRef,
} from "@/hooks/github/mutations"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "./classrooms"
import {
  getRawFile,
  getUser,
  getUserById,
  listClassroomDirs,
  listTeamMembers,
  ONBOARDING_READ_CONCURRENCY,
} from "@/hooks/github/queries"
import { getAuthenticatedUser } from "@/api/queries/users"
import { getBranchRef, getClassroomJson, getCommit } from "../github/queries"
import { GitHubAPIError } from "@/hooks/github/errors"
import { isSameGitHubUser } from "@/util/students"
import { studentKey, rosterClaimSet } from "@/util/identity"
import { prefixCommit } from "@/util/commit"
import { normalizeEmail } from "@/util/onboarding"
import { mapWithConcurrency } from "@/util/concurrency"
import { type Student } from "@/types/classroom"

// Slug is authoritative in classroom.json: GitHub may assign a non-derived slug
// on name collision. Only derive on 404/missing team block; propagate transient
// read failures (NOT "no team") so the caller doesn't target a wrong slug.
async function resolveClassroomTeamSlug(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<string> {
  return (await resolveClassroomTeam(client, org, classroom)).slug
}

// Slug + numeric id from a single classroom.json read (404 -> derived slug,
// other errors propagate; id is undefined when absent).
async function resolveClassroomTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<{ slug: string; id?: number }> {
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    if (classroomJson.team?.slug) {
      return { slug: classroomJson.team.slug, id: classroomJson.team.id }
    }
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      throw err
    }
  }
  return { slug: `classroom50-${classroom}` }
}

export type AddStudentToClassroomResult = CreateClassroomResult & {
  student: StudentCsvRow
  // Set when the row committed but the follow-up team add failed (non-fatal).
  teamWarning?: string
}

// Best-effort single-user team add (enroll/mark/match paths). Returns the error
// detail on failure so each caller phrases its own warning; team membership is
// only read access to private templates and is retryable, so it never fails the
// enclosing mutation. `context` is a server-log label.
async function tryAddUserToTeam(
  client: GitHubClient,
  input: { org: string; teamSlug: string; username: string },
  context: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await addUserToTeam(client, {
      org: input.org,
      teamSlug: input.teamSlug,
      username: input.username,
      role: "member",
    })
    return { ok: true }
  } catch (err) {
    console.error(`team add failed (${context}):`, err)
    return { ok: false, detail: getErrorMessage(err) }
  }
}

export const STUDENT_CSV_FIELDS = [
  "username",
  "first_name",
  "last_name",
  "email",
  "section",
  "github_id",
] as const
type StudentCsvField = (typeof STUDENT_CSV_FIELDS)[number]

export type StudentCsvRow = Record<StudentCsvField, string>

export function normalizeStudentRow(
  row: Partial<Record<StudentCsvField, unknown>>,
): StudentCsvRow {
  return {
    username: String(row.username ?? "").trim(),
    first_name: String(row.first_name ?? "").trim(),
    last_name: String(row.last_name ?? "").trim(),
    email: String(row.email ?? "").trim(),
    section: String(row.section ?? "").trim(),
    github_id: String(row.github_id ?? "").trim(),
  }
}

// Split a full name: first token is first_name, the remainder is last_name.
// Accepts null since GitHub's display name may be null. The single canonical
// implementation; re-exported from util/roster as splitName for UI callers.
export function splitName(name: string | null): {
  first_name: string
  last_name: string
} {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  return { first_name: parts.at(0) ?? "", last_name: parts.slice(1).join(" ") }
}

function parseStudentsCsv(csv: string): StudentCsvRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  })

  const fatalErrors = parsed.errors.filter(
    (error) => error.type !== "Delimiter",
  )

  if (fatalErrors.length > 0) {
    throw new Error(
      `Could not parse students.csv: ${parsed.errors
        .map((error) => error.message)
        .join("; ")}`,
    )
  }

  return parsed.data
    .map((row) => normalizeStudentRow(row))
    .filter((row) => row.username || row.github_id || row.email)
}

// Neutralize spreadsheet formula injection (OWASP CSV injection) in the
// free-text fields a teacher OR a GitHub member can influence. A value starting
// with = + - @ (or a leading tab/CR that a spreadsheet treats as a formula
// lead) is prefixed with a single quote so Excel/Sheets render it as text.
// Idempotent: a value already quote-guarded isn't double-prefixed. Applied to
// name/section free text AND to email — email is a member-controlled GitHub
// profile field written verbatim by syncRosterFromTeam/bulk import, so a
// formula-leading verified email (e.g. `=1+1@evil.com`) would otherwise reach
// students.csv and execute on open. Deliberately NOT applied to
// github_id/tokens/hashes/timestamps, which must round-trip byte-exact.
//
// NOTE: this writes the leading quote into the STORED value, so any consumer of
// students.csv (this app's parse layer and the gh-teacher CLI) sees and must
// tolerate it on these fields. The gh-teacher Go writer defangs the same set;
// keep them in lockstep. The guard runs on the stored cell only; email matching
// keys on the normalized (trim+lowercase) email, so guarding the cell does not
// affect match-by-email.
const FORMULA_LEAD = /^[=+\-@\t\r]/
const FORMULA_GUARDED_FIELDS = [
  "first_name",
  "last_name",
  "section",
  "email",
] as const

function escapeFormulaInjection(value: string): string {
  if (!value) return value
  if (value.startsWith("'") && FORMULA_LEAD.test(value.slice(1))) return value
  return FORMULA_LEAD.test(value) ? `'${value}` : value
}

function stringifyStudentsCsv(rows: StudentCsvRow[]) {
  const normalizedRows = rows
    .map((row) => normalizeStudentRow(row))
    .filter((row) => row.username || row.github_id || row.email)
    .map((row) => {
      const guarded = { ...row }
      for (const field of FORMULA_GUARDED_FIELDS) {
        guarded[field] = escapeFormulaInjection(guarded[field])
      }
      return guarded
    })

  return (
    Papa.unparse(normalizedRows, {
      columns: [...STUDENT_CSV_FIELDS],
      delimiter: ",",
      header: true,
      newline: "\n",
    }) + "\n"
  )
}

export async function addStudentToClassroom(
  client: GitHubClient,
  input: AddStudentToClassroomInput,
): Promise<AddStudentToClassroomResult> {
  const normalizedUsername = input.username.trim()

  if (!normalizedUsername) {
    throw new Error("GitHub username is required")
  }

  await assertClassroomNotArchived(client, input.org, input.classroom)

  const ref = await getBranchRef(client, input.org)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = `${input.classroom}/students.csv`

  const currentCsv = await getRawFile(client, {
    org: input.org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })

  const githubUser = await getUser(client, normalizedUsername)
  const currentStudents = parseStudentsCsv(currentCsv)

  const alreadyExists = currentStudents.some(
    (student) =>
      student.username.toLowerCase() === githubUser.login.toLowerCase() ||
      student.github_id === String(githubUser.id),
  )

  if (alreadyExists) {
    throw new Error(`Student already exists: ${githubUser.login}`)
  }

  const nameParts = splitName(githubUser.name)

  const studentEmail = input.email?.trim() ?? githubUser.email ?? ""

  const student: StudentCsvRow = normalizeStudentRow({
    username: githubUser.login,
    first_name: input.first_name?.trim() ?? nameParts.first_name,
    last_name: input.last_name?.trim() ?? nameParts.last_name,
    email: studentEmail,
    section: input.section?.trim() ?? "",
    github_id: String(githubUser.id),
  })

  const nextStudents = [...currentStudents, student]
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Add student: ${input.classroom}/${student.username}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, input.org, newCommit.sha)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    student,
  }
}

export async function addStudentToClassroomWithConflictRetry(
  client: GitHubClient,
  input: AddStudentToClassroomInput,
) {
  return withGitConflictRetry(() => addStudentToClassroom(client, input))
}

type AddEmailInviteToClassroomInput = {
  org: string
  classroom: string
  email: string
  first_name?: string
  last_name?: string
  section?: string
}

// Email-first writer: no GitHub username/id yet, row keyed on the invited
// email, stays "invited" until the student self-reports and the teacher
// reconciles. Dedupes on email (case-insensitive).
export async function addEmailInviteToClassroom(
  client: GitHubClient,
  input: AddEmailInviteToClassroomInput,
): Promise<AddStudentToClassroomResult> {
  const normalizedEmail = input.email.trim()

  if (!normalizedEmail) {
    throw new Error("Email is required")
  }

  await assertClassroomNotArchived(client, input.org, input.classroom)

  const ref = await getBranchRef(client, input.org)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = `${input.classroom}/students.csv`

  const currentCsv = await getRawFile(client, {
    org: input.org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

  const emailKey = normalizedEmail.toLowerCase()
  const alreadyExists = currentStudents.some(
    (student) => student.email.toLowerCase() === emailKey,
  )

  if (alreadyExists) {
    throw new Error(`Student already exists: ${normalizedEmail}`)
  }

  const student: StudentCsvRow = normalizeStudentRow({
    username: "",
    first_name: input.first_name?.trim() ?? "",
    last_name: input.last_name?.trim() ?? "",
    email: normalizedEmail,
    section: input.section?.trim() ?? "",
    github_id: "",
  })

  const nextStudents = [...currentStudents, student]
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Invite student by email: ${input.classroom}/${normalizedEmail}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, input.org, newCommit.sha)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    student,
  }
}

export async function addEmailInviteToClassroomWithConflictRetry(
  client: GitHubClient,
  input: AddEmailInviteToClassroomInput,
) {
  return withGitConflictRetry(() => addEmailInviteToClassroom(client, input))
}

// Resolve a bare email to a GitHub github_id by scanning the org's OTHER
// classroom rosters (GitHub has no email->user lookup). Returns the immutable id
// (callers derive the current login — stored usernames go stale). 2+ DISTINCT
// ids for one email -> "ambiguous" (never guess); no match -> null. `ref` pins
// all reads to one commit.
async function resolveStudentIdentityByEmail(
  client: GitHubClient,
  org: string,
  email: string,
  excludeClassroom: string,
  ref: string,
): Promise<
  | {
      status: "resolved"
      github_id: string
      first_name: string
      last_name: string
    }
  | { status: "ambiguous" }
  | null
> {
  const targetEmail = normalizeEmail(email)

  let dirs
  try {
    dirs = await listClassroomDirs(client, org, ref)
  } catch {
    return null
  }
  const otherClassrooms = dirs
    .map((d) => d.name)
    .filter((name) => name && name !== excludeClassroom)

  const matches = await mapWithConcurrency(
    otherClassrooms,
    ONBOARDING_READ_CONCURRENCY,
    async (classroom) => {
      let csv: string
      try {
        csv = await getRawFile(client, {
          org,
          path: `${classroom}/students.csv`,
          ref,
        })
      } catch {
        return [] // no roster / unreadable — skip
      }
      const rows = parseStudentsCsv(csv)
      // Match an email-first row on its raw email (case-insensitive), restricted
      // to rows with a real github_id so the result keys on the immutable id.
      return rows
        .filter(
          (row) =>
            Boolean(row.github_id.trim()) &&
            normalizeEmail(row.email) === targetEmail,
        )
        .map((row) => ({
          github_id: row.github_id.trim(),
          first_name: row.first_name,
          last_name: row.last_name,
        }))
    },
  )

  const hits = matches.flat()
  const distinctIds = new Set(hits.map((h) => h.github_id))
  if (distinctIds.size === 0) return null
  if (distinctIds.size > 1) return { status: "ambiguous" }
  const first = hits[0]
  return {
    status: "resolved",
    github_id: first.github_id,
    first_name: first.first_name,
    last_name: first.last_name,
  }
}

// Enroll an email-only row (matched by email, since it has no username yet),
// backfilling the resolved identity. Used on the already-member 422 path.
async function enrollEmailRowWithResolvedIdentity(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    email: string
    username: string
    github_id: string
    first_name?: string
    last_name?: string
  },
) {
  return withGitConflictRetry(async () => {
    const { org, classroom } = input
    const ref = await getBranchRef(client, org)
    const commit = await getCommit(client, org, ref.object.sha)
    const studentsFilePath = `${classroom}/students.csv`
    const currentCsv = await getRawFile(client, {
      org,
      path: studentsFilePath,
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv)

    const emailKey = input.email.trim().toLowerCase()
    const nextStudents = currentStudents.map((row) =>
      row.email.toLowerCase() === emailKey && !row.username
        ? normalizeStudentRow({
            ...row,
            username: input.username,
            github_id: input.github_id,
            // Backfill name only where the teacher left it blank (teacher wins);
            // section is not synced — it's classroom-specific.
            first_name: row.first_name?.trim() || (input.first_name ?? ""),
            last_name: row.last_name?.trim() || (input.last_name ?? ""),
          })
        : row,
    )
    const nextCsv = stringifyStudentsCsv(nextStudents)
    await commitStudentsCsv(client, {
      org,
      classroom,
      baseTreeSha: commit.tree.sha,
      parentSha: ref.object.sha,
      content: nextCsv,
      message: prefixCommit(
        `Enroll already-member student: ${classroom}/${input.username}`,
      ),
    })
  })
}

// Commit a new students.csv content in one tree+commit+ref update.
async function commitStudentsCsv(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    baseTreeSha: string
    parentSha: string
    content: string
    message: string
  },
) {
  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: input.baseTreeSha,
    tree: [
      {
        path: `${input.classroom}/students.csv`,
        mode: "100644",
        type: "blob",
        content: input.content,
      },
    ],
  })
  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: input.message,
    tree_sha: tree.sha,
    parents: [input.parentSha],
  })
  await updateRef(client, input.org, newCommit.sha)
}

export type InviteStudentByEmailResult = AddStudentToClassroomResult & {
  // Set when the row committed but the org email-invite failed (non-fatal).
  inviteWarning?: string
}

// Commit the email-only roster row first (authoritative), then best-effort fire
// the org email-invite. A failed invite is non-fatal — the row already landed.
export async function inviteStudentByEmail(
  client: GitHubClient,
  input: AddEmailInviteToClassroomInput,
): Promise<InviteStudentByEmailResult> {
  const result = await addEmailInviteToClassroomWithConflictRetry(client, input)

  // Attach the classroom team to the invite so the student lands in it on
  // acceptance. If the team id can't be attached — the resolve threw, or the
  // classroom has no persisted team block — we still send the invite (the row
  // already landed and a team-less org member is recoverable), but we MUST warn:
  // the reconcile path that used to re-add such a student was removed with the
  // self-report subsystem, and grade collection is now team-driven — a student
  // who accepts a team-less invite becomes an org member absent from the team,
  // so they render as an `unprovisioned` drift row and are silently uncollected
  // until the teacher runs "Sync roster" or "Match account".
  let teamId: number | undefined
  try {
    teamId = (await resolveClassroomTeam(client, input.org, input.classroom)).id
  } catch {
    teamId = undefined
  }
  const teamAttached = Boolean(teamId)

  try {
    await createOrgInvitation(client, {
      org: input.org,
      email: result.student.email,
      team_ids: teamId ? [teamId] : undefined,
    })
    if (!teamAttached) {
      return {
        ...result,
        inviteWarning:
          `${result.student.email} was invited to ${input.org}, but the classroom ` +
          `team couldn't be attached, so the invite was sent without it. Once they ` +
          `accept, run "Sync roster" to add them to the team — otherwise they ` +
          `won't be included in grade collection.`,
      }
    }
  } catch (err) {
    // A 422 means the email already belongs to a member (or is already invited).
    // GitHub gives no identity for the email, so resolve it from the teacher's
    // other rosters: enroll directly if found + active, else drop the stub.
    if (err instanceof GitHubAPIError && err.status === 422) {
      const resolved = await resolveStudentIdentityByEmail(
        client,
        input.org,
        result.student.email,
        input.classroom,
        result.previousCommitSha,
      ).catch(() => null)

      // Derive the current login from the id (stored usernames go stale), then
      // re-check active membership before binding. Ambiguous (2+ ids) is treated
      // like unidentifiable — keep the stub for the teacher's manual match.
      const resolvedLogin =
        resolved?.status === "resolved"
          ? await getUserById(client, resolved.github_id)
              .then((u) => u.login)
              .catch(() => "")
          : ""
      const stillActive =
        Boolean(resolvedLogin) &&
        (await isActiveMember(client, input.org, resolvedLogin))

      if (resolved?.status === "resolved" && resolvedLogin && stillActive) {
        try {
          await enrollEmailRowWithResolvedIdentity(client, {
            org: input.org,
            classroom: input.classroom,
            email: result.student.email,
            username: resolvedLogin,
            github_id: resolved.github_id,
            first_name: resolved.first_name,
            last_name: resolved.last_name,
          })
          return {
            ...result,
            student: {
              ...result.student,
              username: resolvedLogin,
              github_id: resolved.github_id,
              first_name:
                result.student.first_name?.trim() || resolved.first_name || "",
              last_name:
                result.student.last_name?.trim() || resolved.last_name || "",
            },
          }
        } catch (enrollErr) {
          console.error(
            "resolved already-member but enroll write failed:",
            enrollErr,
          )
          // Fall through to the generic warning below (row stays as a stub).
        }
      } else if (!resolved || resolved.status === "ambiguous") {
        // Member but unidentifiable from any roster (no match, or an ambiguous
        // email mapping to multiple students). Keep the invited email row
        // (don't drop it): the student is in the org without onboarding, and the
        // email->login link is unrecoverable post-accept, so the teacher must
        // complete the match by hand (the "Match account" affordance) or delete
        // the row from this classroom's roster. Reconcile surfaces it as
        // needsMatch.
        return {
          ...result,
          inviteWarning:
            `${result.student.email} already belongs to a member of the ${input.org} ` +
            `organization, so no invite was sent. They were kept on this classroom's ` +
            `roster as a pending match — use "Match account" to link their GitHub ` +
            `account, or remove the row if you can't identify them.`,
        }
      }
    }

    console.error("org email invite failed (row committed):", err)
    const detail = getErrorMessage(err)
    return {
      ...result,
      inviteWarning:
        `${result.student.email} was added to the roster, but sending their ` +
        `organization invite failed (${detail}); re-send it from the roster.`,
    }
  }

  return result
}

type AddStudentToClassroomInput = {
  org: string
  classroom: string
  username: string

  first_name?: string
  last_name?: string
  email?: string
  section?: string
  // Write the new row directly as `enrolled` (vs `invited`); set when the
  // student is already an active org member, so they aren't stranded.
  enrolled?: boolean
}
export async function enrollStudentInClassroom(
  client: GitHubClient,
  input: AddStudentToClassroomInput,
) {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)
  // Resolve the classroom team (slug + id) once, concurrently with the commit.
  // Can reject on a transient read; attach a catch to avoid an unhandled rejection.
  const teamPromise = resolveClassroomTeam(client, org, classroom)
  teamPromise.catch(() => {})

  // Already an active member -> write the row enrolled directly (no invite is
  // sent, so reconcile would never confirm them). Best-effort: a failed read
  // falls back to the normal "invited" path.
  const normalizedUsername = input.username.trim()
  const alreadyMember = await isActiveMember(client, org, normalizedUsername)

  const result = await addStudentToClassroomWithConflictRetry(client, {
    ...input,
    enrolled: alreadyMember,
  })

  // CLI order: roster row -> membership -> team. Membership/team failures are
  // non-fatal warnings since the commit already landed.
  const warnings: string[] = []

  // Ensure org membership via the resolved github_id. Pass the classroom team id
  // so the invite carries it: accepting the single org invitation activates team
  // membership too (else a separate team-add leaves the student team-pending
  // until they accept a second invite). ensureOrgMembership swallows the benign
  // already-member/already-pending 422.
  const inviteeId = Number(result.student.github_id)
  if (Number.isFinite(inviteeId) && inviteeId > 0) {
    try {
      const teamId = (await teamPromise).id
      await ensureOrgMembership(client, {
        org,
        username: result.student.username,
        inviteeId,
        teamIds: teamId ? [teamId] : undefined,
      })
    } catch (err) {
      console.error("org invite failed (student enrolled):", err)
      const detail = getErrorMessage(err)
      warnings.push(
        `${result.student.username} was added to the roster, but sending their ` +
          `organization invite failed (${detail}); re-send it from the roster.`,
      )
    }
  }

  // Fallback team-add: covers an already-org-member student (where the invite
  // above was a no-op carrying no team_ids). Idempotent.
  let enrollTeamFailed: string | undefined
  try {
    const teamSlug = (await teamPromise).slug
    const added = await tryAddUserToTeam(
      client,
      { org, teamSlug, username: result.student.username },
      "student enrolled",
    )
    if (!added.ok) enrollTeamFailed = added.detail
  } catch (err) {
    // Slug resolution failed (not the add itself).
    console.error("team resolve failed (student enrolled):", err)
    enrollTeamFailed = getErrorMessage(err)
  }
  if (enrollTeamFailed) {
    warnings.push(
      `${result.student.username} was added to the roster, but adding them to ` +
        `the classroom team failed (${enrollTeamFailed}); they won't have read on private ` +
        `templates until it's retried.`,
    )
  }

  return {
    ...result,
    teamWarning: warnings.length > 0 ? warnings.join(" ") : undefined,
  }
}

export type MatchStudentToAccountInput = {
  org: string
  classroom: string
  // The email-only row's email (its only identifier).
  email: string
  // The GitHub account the teacher picked for this row.
  username: string
  github_id: string
}

// Teacher-initiated manual match for an email-invited row whose student joined
// the org directly (no onboarding repo) and whose identity GitHub no longer
// exposes (the email->login link is dropped once an invite is accepted). The
// teacher selects which org/team member owns the email; this writes that
// identity onto the email-keyed row and enrolls it. Re-verifies the chosen
// account is an ACTIVE member before binding (the same active-membership
// trust model used across the enroll paths, #65/#50), so a wrong/stale pick
// can't bind a non-member.
async function matchStudentToAccount(
  client: GitHubClient,
  input: MatchStudentToAccountInput,
) {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)

  const normalizedUsername = input.username.trim()
  const normalizedEmail = input.email.trim()
  if (!normalizedUsername) {
    throw new Error("A GitHub account is required to complete the match.")
  }
  if (!normalizedEmail) {
    throw new Error("The roster row has no email to match against.")
  }

  // Authoritative member re-check — only an active member can be bound.
  const state = await getOrgMembershipState(client, org, normalizedUsername)
  if (state !== "active") {
    throw new Error(
      `${normalizedUsername} is not an active member of the ${org} organization, so they can't be matched.`,
    )
  }

  const ref = await getBranchRef(client, org)
  const commit = await getCommit(client, org, ref.object.sha)
  const studentsFilePath = `${classroom}/students.csv`
  const currentStudents = parseStudentsCsv(
    await getRawFile(client, {
      org,
      path: studentsFilePath,
      ref: ref.object.sha,
    }),
  )

  const emailKey = normalizeEmail(normalizedEmail)
  // Target the email-only row (no username yet) — the same predicate the
  // email-resolution path uses, so we never re-key a row that already has an
  // identity.
  const isTarget = (row: StudentCsvRow) =>
    normalizeEmail(row.email) === emailKey && !row.username.trim()
  const target = currentStudents.find(isTarget)
  if (!target) {
    throw new Error(
      `No unmatched roster row found for ${normalizedEmail}; it may already be matched.`,
    )
  }

  // Reject if the picked account is already bound to a DIFFERENT row (by
  // immutable github_id or, for a pre-id row, by login). Without this, matching
  // two email rows to the same account — or a stale candidate list re-picking an
  // account another match just claimed — writes one github_id onto two rows,
  // which the roster view masks (dedupe by studentKey) while the CSV stays
  // permanently double-bound. Runs on the freshly-read roster so it composes
  // with a concurrent match under withGitConflictRetry.
  const pickedId = input.github_id.trim()
  const pickedLogin = normalizedUsername.toLowerCase()
  const alreadyClaimed = currentStudents.some(
    (row) =>
      !isTarget(row) &&
      ((Boolean(pickedId) && row.github_id.trim() === pickedId) ||
        (Boolean(pickedLogin) &&
          row.username.trim().toLowerCase() === pickedLogin)),
  )
  if (alreadyClaimed) {
    throw new Error(
      `${normalizedUsername} is already matched to another student on this roster; refresh and pick a different account.`,
    )
  }

  const matchedRow = normalizeStudentRow({
    ...target,
    username: normalizedUsername,
    github_id: input.github_id.trim(),
  })
  const nextStudents = currentStudents.map((row) =>
    isTarget(row) ? matchedRow : row,
  )

  await commitStudentsCsv(client, {
    org,
    classroom,
    baseTreeSha: commit.tree.sha,
    parentSha: ref.object.sha,
    content: stringifyStudentsCsv(nextStudents),
    message: prefixCommit(
      `Match student to account: ${classroom}/${normalizedUsername}`,
    ),
  })

  return { alreadyEnrolled: false, student: matchedRow }
}

export async function matchStudentToAccountWithConflictRetry(
  client: GitHubClient,
  input: MatchStudentToAccountInput,
) {
  const result = await withGitConflictRetry(() =>
    matchStudentToAccount(client, input),
  )

  // Best-effort: ensure the matched member is on the classroom team. Non-fatal.
  let teamWarning: string | undefined
  try {
    const team = await resolveClassroomTeam(client, input.org, input.classroom)
    if (team.slug) {
      const added = await tryAddUserToTeam(
        client,
        {
          org: input.org,
          teamSlug: team.slug,
          username: result.student.username,
        },
        "match account",
      )
      if (!added.ok) {
        teamWarning =
          `${result.student.username} was matched, but adding them to the ` +
          `classroom team failed; they won't have read on private templates until ` +
          `it's retried.`
      }
    }
  } catch (err) {
    console.error("team resolve failed (match account):", err)
    teamWarning =
      `${result.student.username} was matched, but adding them to the ` +
      `classroom team failed; they won't have read on private templates until ` +
      `it's retried.`
  }

  return { ...result, teamWarning }
}

type BulkImportProgress = {
  processed: number
  total: number
  message: string
}
export type AddStudentsToClassroomInput = {
  org: string
  classroom: string
  usernames: string[]
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

export const normalizeGithubUsername = (username: string) => {
  return username.trim().replace(/^@/, "")
}

export const isLikelyGithubUsername = (username: string) => {
  // alphanumeric + hyphens, no hyphens at start or end
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)
}

export async function addStudentsToClassroom(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
): Promise<AddStudentsToClassroomResult> {
  const normalizedUsernames = Array.from(
    new Map(
      input.usernames
        .map((username) => normalizeGithubUsername(username))
        .filter(Boolean)
        .map((username) => [username.toLowerCase(), username]),
    ).values(),
  )

  if (normalizedUsernames.length === 0) {
    throw new Error("At least one GitHub username is required")
  }

  await assertClassroomNotArchived(client, input.org, input.classroom)

  input.onProgress?.({
    processed: 0,
    total: normalizedUsernames.length,
    message: "Reading current students.csv...",
  })

  const ref = await getBranchRef(client, input.org)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = `${input.classroom}/students.csv`

  const currentCsv = await getRawFile(client, {
    org: input.org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

  const existingUsernameKeys = new Set(
    currentStudents.map((student) => student.username.toLowerCase()),
  )

  const existingGithubIds = new Set(
    currentStudents.map((student) => student.github_id).filter(Boolean),
  )

  const skippedStudents: AddStudentsToClassroomResult["skippedStudents"] = []
  const addedStudents: StudentCsvRow[] = []

  let processed = 0

  for (const username of normalizedUsernames) {
    input.onProgress?.({
      processed,
      total: normalizedUsernames.length,
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

    if (existingUsernameKeys.has(username.toLowerCase())) {
      skippedStudents.push({
        username,
        reason: "duplicate",
        message: "Student is already in students.csv",
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
          message: "Student GitHub ID is already in students.csv",
        })

        processed++
        continue
      }

      const nameParts = splitName(githubUser.name)

      const studentEmail = githubUser.email ?? ""

      const student = normalizeStudentRow({
        username: githubUser.login,
        first_name: nameParts.first_name,
        last_name: nameParts.last_name,
        email: studentEmail,
        section: "",
        github_id: String(githubUser.id),
      })

      existingUsernameKeys.add(student.username.toLowerCase())
      existingGithubIds.add(student.github_id)
      addedStudents.push(student)
    } catch (err) {
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
      total: normalizedUsernames.length,
      message: `Checked ${processed} of ${normalizedUsernames.length} usernames...`,
    })
  }

  if (addedStudents.length === 0) {
    throw new Error("No new students to add")
  }

  input.onProgress?.({
    processed,
    total: normalizedUsernames.length,
    message: "Writing students.csv...",
  })

  const nextStudents = [...currentStudents, ...addedStudents]
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
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

  const updatedRef = await updateRef(client, input.org, newCommit.sha)

  input.onProgress?.({
    processed: normalizedUsernames.length,
    total: normalizedUsernames.length,
    message: "students.csv updated.",
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

export type SyncRosterFromTeamResult = {
  // Team members newly appended to students.csv as metadata rows.
  addedUsernames: string[]
  // No missing members — nothing was committed.
  noop: boolean
}

// Backfill students.csv from the classroom team: ensure every active team
// member has a metadata row (keyed by github_id), appended in ONE commit. The
// team is the source of truth for enrollment; this only persists optional
// display metadata. Never removes rows (CSV-only rows are drift, not deletions).
//
// The diff is recomputed INSIDE the retried closure (re-reading both the team
// and the CSV each attempt) so a 409 retry or a concurrent teacher edit can't
// reintroduce or duplicate rows. Uses the same github_id -> username fallback
// join as the roster view when deciding "missing", so a pre-resolution row with
// an empty github_id isn't treated as missing (which would append a duplicate).
export async function syncRosterFromTeam(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<SyncRosterFromTeamResult> {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)

  const teamSlug = await resolveClassroomTeamSlug(client, org, classroom)

  return withGitConflictRetry(async () => {
    // Re-read team + CSV on every attempt so the diff is always against the
    // latest state (a concurrent add/edit can't be clobbered or duplicated).
    const [members, ref] = await Promise.all([
      listTeamMembers(client, org, teamSlug),
      getBranchRef(client, org),
    ])
    const commit = await getCommit(client, org, ref.object.sha)

    const studentsFilePath = `${classroom}/students.csv`
    const currentCsv = await getRawFile(client, {
      org,
      path: studentsFilePath,
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv)

    const { ids, logins } = rosterClaimSet(currentStudents)
    // Email set mirrors buildTeamRoster's indexCsv.byEmail fold: a member whose
    // GitHub profile email matches an existing (e.g. pre-resolution, id/login-
    // less) CSV row is the SAME person the view already folds by email, so
    // appending would create a duplicate email-colliding row the view masks but
    // that breaks email-keyed logic (match-by-email, invite dedupe).
    const emails = new Set(
      currentStudents
        .map((s) => s.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e)),
    )

    // A member is "missing" when their numeric id, login, AND email are all
    // unclaimed by any CSV row (the same id -> login -> email fallback join the
    // roster view uses, so append and display can't diverge).
    const missing = members.filter(
      (m) =>
        !ids.has(String(m.id)) &&
        !logins.has(m.login.toLowerCase()) &&
        !(m.email ? emails.has(m.email.trim().toLowerCase()) : false),
    )

    if (missing.length === 0) {
      return { addedUsernames: [], noop: true }
    }

    const addedRows = missing.map((m) => {
      const nameParts = splitName(m.name)
      return normalizeStudentRow({
        username: m.login,
        first_name: nameParts.first_name,
        last_name: nameParts.last_name,
        email: m.email ?? "",
        section: "",
        github_id: String(m.id),
      })
    })

    const nextCsv = stringifyStudentsCsv([...currentStudents, ...addedRows])

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: studentsFilePath,
          mode: "100644",
          type: "blob",
          content: nextCsv,
        },
      ],
    })

    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Sync ${addedRows.length} team member${
          addedRows.length === 1 ? "" : "s"
        } into roster: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })

    await updateRef(client, org, newCommit.sha)

    return {
      addedUsernames: addedRows.map((r) => r.username),
      noop: false,
    }
  })
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

  const total = bulkInput.usernames.length

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
    teamSlugError = getErrorMessage(err)
  }

  const teamResults: BulkImportResult["teamResults"] = []

  for (let i = 0; i < addResult.addedStudents.length; i++) {
    const student = addResult.addedStudents[i]

    onProgress?.({
      processed: i,
      total: addResult.addedStudents.length,
      message: `Adding ${student.username} to classroom team...`,
    })

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

  return {
    ...addResult,
    teamResults,
  }
}

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
  await assertClassroomNotArchived(client, org, classroom)
  const normalizedUsername = toRemoveStudent?.username.trim()
  const normalizedEmail = toRemoveStudent?.email?.trim()

  // A mid-onboarding email row has no username yet, so accept email too. One of
  // the two must be present to target a row.
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

  const ref = await getBranchRef(client, org)
  const commit = await getCommit(client, org, ref.object.sha)

  const studentsFilePath = `${classroom}/students.csv`

  const currentCsv = await getRawFile(client, {
    org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

  // Match the target row. Prefer username/github_id; fall back to email for a
  // not-yet-reconciled email row.
  const sameRow = (student: StudentCsvRow) => {
    if (normalizedUsername || toRemoveStudent.github_id) {
      return (
        student.username.toLowerCase() ===
          toRemoveStudent.username.toLowerCase() ||
        (Boolean(student.github_id) &&
          student.github_id === String(toRemoveStudent.github_id))
      )
    }
    return (
      Boolean(normalizedEmail) &&
      student.email.toLowerCase() === normalizedEmail!.toLowerCase()
    )
  }

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
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Remove student: ${classroom}/${toRemoveStudent.username || normalizedEmail}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha)

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
      console.error("team removal failed (student unenrolled):", err)
      const detail = getErrorMessage(err)
      warnings.push(
        `${toRemoveStudent.username} was removed from the roster, but removing ` +
          `them from the classroom team failed (${detail}); they may keep read on ` +
          `private templates until it's retried.`,
      )
    }
  }

  // Cancel a pending invite (a not-yet-accepted invitee has no cross-classroom
  // footprint). An ACTIVE member is never removed here — unenroll is
  // classroom-scoped; org removal lives on the Members page.
  // Resolve defensively: a reject after the roster commit landed would discard
  // accumulated warnings and break the "commit landed -> non-fatal" guarantee.
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
    try {
      await removeOrgMembership(client, { org, username: normalizedUsername })
    } catch (err) {
      console.error("org invite cancellation failed (student unenrolled):", err)
      const detail = getErrorMessage(err)
      warnings.push(
        `${toRemoveStudent.username} was removed from the roster, but ` +
          `cancelling their pending org invite failed (${detail}); retry from ` +
          `the organization's people page.`,
      )
    }
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    teamWarning: warnings.length > 0 ? warnings.join(" ") : undefined,
  }
}

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
}

export type UpdateStudentResult = CreateClassroomResult & {
  student: StudentCsvRow
}

// Edit one roster row's teacher-facing fields in place and commit the rewritten
// students.csv. Identity columns are preserved verbatim from the matched row.
export async function updateStudent(
  client: GitHubClient,
  input: UpdateStudentInput,
): Promise<UpdateStudentResult> {
  const { org, classroom, key, patch } = input

  const targetKey = key.trim()
  if (!targetKey) {
    throw new Error("A student row identity is required")
  }

  await assertClassroomNotArchived(client, org, classroom)

  const ref = await getBranchRef(client, org)
  const commit = await getCommit(client, org, ref.object.sha)

  const studentsFilePath = `${classroom}/students.csv`

  const currentCsv = await getRawFile(client, {
    org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

  // Stable per-row identity via the shared studentKey (github_id -> username ->
  // email), the same precedence the UI and reconcile use.
  const targetIndex = currentStudents.findIndex(
    (row) => studentKey(row) === targetKey,
  )

  if (targetIndex === -1) {
    throw new Error(`Student does not exist in roster: ${targetKey}`)
  }

  const existing = currentStudents[targetIndex]

  const nextEmail = patch.email.trim()
  const emailChanged = nextEmail.toLowerCase() !== existing.email.toLowerCase()

  // An email-only row (no username, no github_id) is identified solely by its
  // email: it's that row's studentKey, both server-side here and in the UI's
  // optimistic cache. Editing the email would re-key (or, if cleared, drop) the
  // row — stringifyStudentsCsv discards keyless rows, so a cleared email
  // silently deletes the student. Refuse any email change on such a row; the
  // teacher should unenroll instead.
  if (emailChanged && !existing.username && !existing.github_id) {
    throw new Error(
      "Can't change the email for this student: they have no GitHub username " +
        "or id, so their email is their only identifier. Unenroll and re-add " +
        "them to change it.",
    )
  }

  // Guard against editing an email into one already held by ANOTHER row
  // (case-insensitive). The target row matching its own current email is fine.
  if (nextEmail) {
    const emailKey = nextEmail.toLowerCase()
    const clash = currentStudents.some(
      (row, idx) => idx !== targetIndex && row.email.toLowerCase() === emailKey,
    )
    if (clash) {
      throw new Error(`Email already used by another student: ${nextEmail}`)
    }
  }

  // Spread the existing row so identity columns are preserved, then overwrite
  // only the four editable fields.
  const updatedStudent = normalizeStudentRow({
    ...existing,
    first_name: patch.first_name,
    last_name: patch.last_name,
    email: nextEmail,
    section: patch.section,
  })

  const nextStudents = currentStudents.map((row, idx) =>
    idx === targetIndex ? updatedStudent : row,
  )
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Edit student: ${classroom}/${updatedStudent.username || updatedStudent.email || targetKey}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha)

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
