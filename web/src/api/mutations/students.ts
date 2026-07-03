import Papa from "papaparse"
import type { GitHubClient } from "@/hooks/github/client"
import {
  addUserToTeam,
  archiveRepo,
  createGitCommit,
  createGitTree,
  createOrgInvitation,
  deleteRepo,
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
  getFileCommitAuthorIds,
  getOrgInvitations,
  getRawFile,
  getRepoFile,
  getUser,
  getUserById,
  listClassroomDirs,
  listOnboardingRepos,
  ONBOARDING_READ_CONCURRENCY,
} from "@/hooks/github/queries"
import { getAuthenticatedUser } from "@/api/queries/users"
import { getBranchRef, getClassroomJson, getCommit } from "../github/queries"
import { GitHubAPIError } from "@/hooks/github/errors"
import { isEnrolledRow, isSameGitHubUser } from "@/util/students"
import { studentKey } from "@/util/identity"
import { prefixCommit } from "@/util/commit"
import {
  emailHash,
  generateInviteToken,
  isReconcilableRow,
  normalizeEmail,
  onboardingRepoName,
  ONBOARDING_YAML_PATH,
  rowMatchesEmailHash,
} from "@/util/onboarding"
import { matchReportToRow } from "@/util/reconcileMatch"
import { parseOnboardingYaml } from "@/util/yaml"
import { mapWithConcurrency } from "@/util/concurrency"
import {
  DEFAULT_ONBOARDING_CLEANUP,
  type OnboardingCleanupMode,
  type Student,
} from "@/types/classroom"

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
  // Email-first columns appended after the original 6 so old CSVs still parse.
  "enrollment_status",
  "enrollment_method",
  "email_hash",
  "invite_token",
  "invited_at",
  "enrolled_at",
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
    enrollment_status: String(row.enrollment_status ?? "").trim(),
    enrollment_method: String(row.enrollment_method ?? "").trim(),
    email_hash: String(row.email_hash ?? "").trim(),
    invite_token: String(row.invite_token ?? "").trim(),
    invited_at: String(row.invited_at ?? "").trim(),
    enrolled_at: String(row.enrolled_at ?? "").trim(),
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
// free-text fields a teacher controls. A value starting with = + - @ (or a
// leading tab/CR that a spreadsheet treats as a formula lead) is prefixed with
// a single quote so Excel/Sheets render it as text. Idempotent: a value already
// quote-guarded isn't double-prefixed. Applied ONLY to teacher-entered free
// text — never to email/github_id/tokens/hashes/timestamps, which must
// round-trip byte-exact for reconcile and the gh-teacher CLI.
//
// NOTE: this writes the leading quote into the STORED value, so any consumer of
// students.csv (this app's parse layer and the gh-teacher CLI) sees and must
// tolerate it on these three fields. Cross-binary contract — keep in lockstep.
const FORMULA_LEAD = /^[=+\-@\t\r]/
const FORMULA_GUARDED_FIELDS = ["first_name", "last_name", "section"] as const

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

  const now = new Date().toISOString()
  const student: StudentCsvRow = normalizeStudentRow({
    username: githubUser.login,
    first_name: input.first_name?.trim() ?? nameParts.first_name,
    last_name: input.last_name?.trim() ?? nameParts.last_name,
    email: studentEmail,
    section: input.section?.trim() ?? "",
    github_id: String(githubUser.id),
    // Already-member students are written "enrolled" directly (input.enrolled):
    // no invite/onboarding repo exists for them, so reconcile can't confirm them.
    enrollment_status: input.enrolled ? "enrolled" : "invited",
    enrollment_method: "github",
    email_hash: studentEmail ? await emailHash(studentEmail) : "",
    // Unique invite token so a per-student secure onboarding link always exists
    // (reconcile's strongest match key; else falls back to github_id / email).
    invite_token: generateInviteToken(),
    invited_at: now,
    enrolled_at: input.enrolled ? now : "",
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
    enrollment_status: "invited",
    enrollment_method: "email",
    email_hash: await emailHash(normalizedEmail),
    // Unique invite token so a per-student secure onboarding link always exists
    // (reconcile's strongest match key when used; else falls back to github_id
    // then email). The token never names the repo.
    invite_token: generateInviteToken(),
    invited_at: new Date().toISOString(),
    enrolled_at: "",
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
  const targetHash = await emailHash(email)

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
      // Match by email on rows with a real id. The email_hash/email guard blocks
      // rowMatchesEmailHash's keyless-true fallthrough; requiring github_id keys
      // the result on the immutable id.
      return rows
        .filter(
          (row) =>
            Boolean(row.github_id.trim()) &&
            (Boolean(row.email_hash) || Boolean(row.email.trim())) &&
            rowMatchesEmailHash(row, email, targetHash),
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
    const now = new Date().toISOString()
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
            enrollment_status: "enrolled",
            enrolled_at: now,
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
  // acceptance. Best-effort: if the id can't resolve, reconcile adds them later.
  const teamId = await resolveClassroomTeam(client, input.org, input.classroom)
    .then((team) => team.id)
    .catch(() => undefined)

  try {
    await createOrgInvitation(client, {
      org: input.org,
      email: result.student.email,
      team_ids: teamId ? [teamId] : undefined,
    })
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
              enrollment_status: "enrolled",
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

export type ReconcileOnboardingResult = {
  // Rows newly bound to a GitHub identity this run.
  reconciled: { email: string; username: string }[]
  // Reconcilable rows with no matching self-report (not onboarded yet).
  pending: string[]
  // Repos whose payload couldn't be parsed/verified, or verified self-reports
  // that matched no roster row.
  unmatched: { repo: string; reason: string }[]
  // Verified self-reports matching no roster row (e.g. joined via raw org link).
  // Reported for teacher awareness; no automatic roster add.
  needsAttention: { github_id: string; login: string }[]
  // Email-invited rows whose invite was accepted (so the student joined the org
  // directly, no onboarding repo) but whose GitHub identity can't be recovered
  // — GitHub drops the email->login link once an invitation is accepted. The
  // teacher must complete the match by hand (pick the account) or remove the
  // unidentifiable person from the org.
  needsMatch: { email: string }[]
  // Onboarding repos archived after a successful reconcile.
  archived: string[]
  // Onboarding repos deleted after a successful reconcile.
  deleted: string[]
  // Set when cleanup couldn't honor the configured mode (e.g. delete fell back
  // to archive for lack of the delete_repo scope).
  cleanupWarning?: string
}

// Teacher-side reconciliation: read each onboarding repo's self-report YAML,
// verify the writer's GitHub-attested identity, and fold it into the matching
// roster row. The repo name is derivable (onboarding-<github-id>) and attests
// nothing, so matching is driven entirely by payload contents (invite_token,
// then github_id, then email) — never the repo name. All updates land in ONE
// students.csv commit (withGitConflictRetry) so a batch reconcile is a single
// race window, not N.
export async function reconcileOnboarding(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<ReconcileOnboardingResult> {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)
  const studentsFilePath = `${classroom}/students.csv`

  const result: ReconcileOnboardingResult = {
    reconciled: [],
    pending: [],
    unmatched: [],
    needsAttention: [],
    needsMatch: [],
    archived: [],
    deleted: [],
  }

  // Per-classroom cleanup mode. A 404 (no classroom.json) is a genuine "unset"
  // -> keep the configured default. Any OTHER read failure is transient and must
  // NOT be misread as unset: defaulting to delete on a blip would irreversibly
  // delete repos. So fall back to the SAFE "keep" mode and warn; cleanup can be
  // retried once the read recovers, but a deletion cannot be undone.
  let cleanupMode: OnboardingCleanupMode = DEFAULT_ONBOARDING_CLEANUP
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    if (classroomJson.onboarding_cleanup) {
      cleanupMode = classroomJson.onboarding_cleanup
    }
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      cleanupMode = "keep"
      result.cleanupWarning =
        "Couldn't read the classroom cleanup setting, so onboarding repos were " +
        "kept (not deleted or archived) to avoid an unintended deletion. " +
        "Re-run reconcile once the connection recovers to clean them up."
    }
    // A 404 means no classroom.json; keep the configured default.
  }

  // Read the roster once (outside the retry) to drive matching.
  const headRef = await getBranchRef(client, org)
  const roster = parseStudentsCsv(
    await getRawFile(client, {
      org,
      path: studentsFilePath,
      ref: headRef.object.sha,
    }),
  )

  // Match targets: reconcilable rows (an already-enrolled row is never
  // re-matched). Matched below by linear scan, strongest key first:
  // invite_token, then github_id, then email.
  const targets = roster.filter(isReconcilableRow)

  // A verified self-report matched to a roster target (each row to at most one
  // report, each report to at most one row). matchBy/matchValue record how the
  // row was found so the commit phase can re-find the SAME row (no drift).
  type Resolved = {
    repo: string
    username: string
    github_id: string
    email: string
    first_name: string
    last_name: string
    matchBy: "token" | "github_id" | "email" | "username"
    matchValue: string
  }
  const resolved: Resolved[] = []
  // Guards so two reports can't claim the same row, and one report isn't
  // applied twice.
  const claimedGithubIds = new Set<string>()
  const claimedRows = new Set<StudentCsvRow>()
  // Redundant repos for an already-claimed github_id (e.g. a re-onboard left a
  // second repo). Cleaned up so they don't re-surface as orphans every run.
  const redundantRepos: string[] = []

  const onboardingRepos = await listOnboardingRepos(client, org)

  // Read every repo's self-report YAML up front, bounded-parallel (the per-repo
  // read dominates). A 404 means the repo exists but its commit hasn't landed —
  // skip quietly; any other error is a real problem on an existing repo.
  type RepoRead = {
    repo: string
    payload?: ReturnType<typeof parseOnboardingYaml>
    readError?: string
  }
  const reads: RepoRead[] = await mapWithConcurrency(
    onboardingRepos,
    ONBOARDING_READ_CONCURRENCY,
    async (repoMeta): Promise<RepoRead> => {
      const repo = repoMeta.name
      try {
        return {
          repo,
          payload: parseOnboardingYaml(
            await getRepoFile(client, org, repo, ONBOARDING_YAML_PATH),
          ),
        }
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isNotFound) {
          return { repo }
        }
        return { repo, readError: getErrorMessage(err) }
      }
    },
  )

  // Resolve sequentially: the claimedRows/claimedGithubIds "first verified
  // report wins" semantics are order-dependent and must not race. The expensive
  // reads already happened in parallel above.
  for (const { repo, payload, readError } of reads) {
    if (readError !== undefined) {
      result.unmatched.push({ repo, reason: readError })
      continue
    }
    if (!payload) {
      // 404 read -> repo exists but YAML not committed yet.
      continue
    }

    // Only this classroom's reports (the YAML carries the classroom; the repo is
    // one per-student-per-org). A student joining a SECOND classroom is already a
    // member, so that path short-circuits to a direct roster add + the
    // membership pass below — no fresh self-report needed.
    if (payload.classroom !== classroom) {
      continue
    }

    // Trust the payload only if the commit author/committer id matches the
    // claimed github_id — this keeps a guessable repo name safe for the honest
    // flow (a student's own commit binds only their id). Accepted residual risk:
    // author.id is forgeable, but the create->commit->demote window is small and
    // students aren't expected to pre-create repos. Skip a transient read
    // failure (retryable) without asserting a mismatch.
    let authorIds: number[]
    try {
      authorIds = await getFileCommitAuthorIds(
        client,
        org,
        repo,
        ONBOARDING_YAML_PATH,
      )
    } catch (err) {
      result.unmatched.push({
        repo,
        reason: `couldn't verify the self-report author (${getErrorMessage(err)}); retry reconcile`,
      })
      continue
    }
    if (!authorIds.includes(payload.github_id)) {
      result.unmatched.push({
        repo,
        reason: `self-report identity (${payload.github_username}) does not match the account that wrote it`,
      })
      continue
    }

    const payloadId = String(payload.github_id)
    if (claimedGithubIds.has(payloadId)) {
      // A second verified report from the same account (e.g. a re-onboard left
      // a duplicate repo). The first already bound the row; route to cleanup so
      // it doesn't linger as an orphan.
      redundantRepos.push(repo)
      continue
    }

    // Match the verified report back to a row via the shared matcher (the same
    // one the UI "ready" badge uses), strongest key first: invite_token, then
    // github_id, then email. A row is matched at most once (claimedRows), so a
    // report can't steal a row another took. The email pass is the last resort
    // for a genuinely email-first row (no token, no github_id) onboarded via the
    // classroom-wide link.
    // SECURITY: the claimed email is attacker-supplied (only github_id is
    // GitHub-attested), so the email path is accepted residual risk for students
    // who skip their secure link; token/github_id matches are unaffected.
    // Hash the payload email once so matching N rows doesn't re-hash it N times.
    const payloadEmailHash = await emailHash(payload.email)
    const matchResult = matchReportToRow(
      {
        invite_token: payload.invite_token,
        github_id: payloadId,
        email: payload.email,
        emailHash: payloadEmailHash,
      },
      targets,
      {
        isClaimed: (row) => claimedRows.has(row),
        // Stable email key for the commit phase: the row's email_hash, or a
        // placeholder derived below (the row always carries one here, since the
        // email pass requires an email key).
        emailKeyOf: (row) => row.email_hash || "",
      },
    )

    let matched:
      { row: StudentCsvRow; by: Resolved["matchBy"]; value: string } | undefined

    if (matchResult && "ambiguous" in matchResult) {
      result.unmatched.push({
        repo,
        reason: `self-report email (${payload.email}) matches ${matchResult.count} roster rows; resolve the duplicate emails or send the student their secure link`,
      })
      continue
    }
    if (matchResult) {
      // For an email match, the stable key must survive the post-commit CSV
      // re-read: use the row's email_hash, or derive one from its email so the
      // re-match agrees.
      const value =
        matchResult.by === "email" && !matchResult.value
          ? await emailHash(matchResult.row.email)
          : matchResult.value
      matched = { row: matchResult.row, by: matchResult.by, value }
    }

    if (!matched) {
      // Verified, but no roster row to bind to (e.g. joined via a raw link).
      // Surface for teacher awareness; no automatic roster add.
      result.needsAttention.push({
        github_id: payloadId,
        login: payload.github_username,
      })
      continue
    }

    claimedGithubIds.add(payloadId)
    claimedRows.add(matched.row)
    resolved.push({
      repo,
      username: payload.github_username,
      github_id: payloadId,
      email: payload.email,
      first_name: payload.first_name,
      last_name: payload.last_name,
      matchBy: matched.by,
      matchValue: matched.value,
    })
    result.reconciled.push({
      email: matched.row.email || payload.email,
      username: payload.github_username,
    })
  }

  // Membership pass: a row that carries a GitHub identity (github_id/username)
  // but never produced a self-report repo is the "joined the org directly"
  // case (accepting the org invite activates org + team membership via team_ids,
  // bypassing onboarding). If that account is an ACTIVE org member, bind it now
  // — github_id is GitHub-attested and an active membership re-check is the same
  // trust model as markStudentEnrolled, so this is safe to auto-enroll
  // without a self-report. Bounded-parallel; only rows with a username can be
  // membership-checked (the GitHub endpoint is keyed by username).
  const membershipCandidates = targets.filter(
    (row) => !claimedRows.has(row) && Boolean(row.username.trim()),
  )
  const membershipChecks = await mapWithConcurrency(
    membershipCandidates,
    ONBOARDING_READ_CONCURRENCY,
    async (row) => ({
      row,
      // Transient failure resolves to false, leaving the row pending; a later
      // reconcile retries.
      active: await isActiveMember(client, org, row.username.trim()),
    }),
  )
  for (const { row, active } of membershipChecks) {
    if (!active || claimedRows.has(row)) continue
    const githubId = row.github_id.trim()
    // A github_id lets the commit phase re-bind by the immutable key; without
    // one, fall back to the username (recorded via matchBy "username").
    const matchBy: Resolved["matchBy"] = githubId ? "github_id" : "username"
    const matchValue = githubId || row.username.trim().toLowerCase()
    if (githubId && claimedGithubIds.has(githubId)) continue
    if (githubId) claimedGithubIds.add(githubId)
    claimedRows.add(row)
    resolved.push({
      repo: "",
      username: row.username,
      github_id: githubId,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      matchBy,
      matchValue,
    })
    result.reconciled.push({
      email: row.email || row.username,
      username: row.username,
    })
  }

  // Email-invite pass: rows with no GitHub identity (email-only) that the
  // membership pass couldn't bind. The student may have accepted the org invite
  // directly (no onboarding repo). GitHub drops the email->login link once an
  // invitation is accepted, so we can't auto-bind from the email alone. Three
  // outcomes per row:
  //   1. Invite still PENDING -> genuinely awaiting acceptance -> pending.
  //   2. Accepted/expired + the email resolves to an ACTIVE member via the
  //      teacher's OTHER rosters (cross-roster identity) -> auto-enroll.
  //   3. Otherwise -> needsMatch: the teacher completes the match by hand.
  const emailOnlyRows = targets.filter(
    (row) =>
      !claimedRows.has(row) &&
      !row.github_id.trim() &&
      !row.username.trim() &&
      Boolean(row.email.trim()),
  )
  if (emailOnlyRows.length > 0) {
    // Pending invitations are owner-only; a non-owner read 403s. Fail SAFE: if
    // we can't tell whether an invite is still pending, treat every email row as
    // pending (never auto-enroll or push to needsMatch on a blind read), so a
    // permission/transient failure can't strand or mis-resolve a row.
    const pendingInviteEmails: Set<string> | null = await getOrgInvitations(
      client,
      org,
    )
      .then(
        (invitations) =>
          new Set(
            invitations
              .map((inv) => (inv.email ? normalizeEmail(inv.email) : undefined))
              .filter((email): email is string => Boolean(email)),
          ),
      )
      .catch(() => null)

    for (const row of emailOnlyRows) {
      const emailLower = normalizeEmail(row.email)
      if (pendingInviteEmails === null) {
        result.pending.push(row.email || row.username)
        continue
      }
      if (pendingInviteEmails.has(emailLower)) {
        // Still awaiting acceptance.
        result.pending.push(row.email || row.username)
        continue
      }

      // Accepted (or expired): recover the identity from other rosters by id,
      // derive the current login (stored usernames go stale), re-check active
      // membership before binding. Ambiguous (2+ ids) -> needsMatch (never guess).
      const resolvedIdentity = await resolveStudentIdentityByEmail(
        client,
        org,
        row.email,
        classroom,
        headRef.object.sha,
      ).catch(() => null)

      if (resolvedIdentity?.status === "ambiguous") {
        result.needsMatch.push({ email: row.email })
        continue
      }

      // Derive the current login from the authoritative id; the roster's stored
      // username may be outdated after a GitHub rename.
      let resolvedLogin = ""
      if (resolvedIdentity?.status === "resolved") {
        resolvedLogin = await getUserById(client, resolvedIdentity.github_id)
          .then((u) => u.login)
          .catch(() => "")
      }
      const active = resolvedLogin
        ? await isActiveMember(client, org, resolvedLogin)
        : false

      if (resolvedIdentity?.status === "resolved" && resolvedLogin && active) {
        const githubId = resolvedIdentity.github_id
        if (githubId && claimedGithubIds.has(githubId)) {
          // Another row already bound this account; surface for the teacher.
          result.needsMatch.push({ email: row.email })
          continue
        }
        if (githubId) claimedGithubIds.add(githubId)
        claimedRows.add(row)
        resolved.push({
          repo: "",
          username: resolvedLogin,
          github_id: githubId,
          email: row.email,
          first_name: row.first_name || resolvedIdentity.first_name,
          last_name: row.last_name || resolvedIdentity.last_name,
          // Re-bind by the row's email key in the commit phase (the row stays
          // email-keyed until this commit writes the resolved username).
          matchBy: "email",
          matchValue: row.email_hash || (await emailHash(row.email)),
        })
        result.reconciled.push({
          email: row.email,
          username: resolvedLogin,
        })
        continue
      }

      // Accepted but unidentifiable: the teacher must complete the match.
      result.needsMatch.push({ email: row.email })
    }
  }

  // Reconcilable rows with no matching self-report this run = not onboarded yet.
  // claimedRows holds exactly the target rows bound during the resolve phase, so
  // membership is the authoritative "resolved" test (no re-matching/re-hashing).
  // needsMatch rows are surfaced for manual matching, not counted as pending.
  const needsMatchEmails = new Set(result.needsMatch.map((m) => m.email))
  for (const row of targets) {
    if (!claimedRows.has(row) && !needsMatchEmails.has(row.email)) {
      result.pending.push(row.email || row.username)
    }
  }

  // Nothing to bind this run. redundantRepos only accumulate when a github_id
  // was resolved (so resolved is non-empty whenever redundantRepos is).
  if (resolved.length === 0) {
    return result
  }

  // Resolved entries actually written this run. A resolved entry is only
  // "committed" when it bound to a freshly-read, not-already-enrolled row.
  // Team-add and cleanup are driven from THIS set (not resolved[]), so a repo
  // whose row was already enrolled or failed to re-bind is never touched.
  let committed: Resolved[] = []

  // Value a freshly-read row presents for a given match kind, so a resolved
  // entry can re-bind to the same logical row by matchBy/matchValue after the
  // commit-phase re-read (the resolve-phase row objects no longer apply).
  const rowKeyForMatchBy = async (
    row: StudentCsvRow,
    matchBy: Resolved["matchBy"],
  ): Promise<string | undefined> => {
    if (matchBy === "token") return row.invite_token || undefined
    if (matchBy === "github_id") return row.github_id || undefined
    if (matchBy === "username")
      return row.username ? row.username.trim().toLowerCase() : undefined
    return (
      row.email_hash || (row.email ? await emailHash(row.email) : undefined)
    )
  }

  // Single batched commit. Re-reads the roster inside the retry so it applies
  // onto the latest students.csv even if another write landed meanwhile.
  await withGitConflictRetry(async () => {
    const ref = await getBranchRef(client, org)
    const commit = await getCommit(client, org, ref.object.sha)
    const current = parseStudentsCsv(
      await getRawFile(client, {
        org,
        path: studentsFilePath,
        ref: ref.object.sha,
      }),
    )

    // Re-bind each resolved report to the freshly-read row by its recorded match
    // key (the resolve-phase row objects differ after the re-read). Shared
    // rowKeyForMatchBy keeps resolve and commit phases from drifting.
    const matchByRow = new Map<StudentCsvRow, Resolved>()
    for (const row of current) {
      for (const r of resolved) {
        const key = await rowKeyForMatchBy(row, r.matchBy)
        if (key !== undefined && key === r.matchValue) {
          matchByRow.set(row, r)
          break
        }
      }
    }

    // Reset per attempt (withGitConflictRetry may re-run this block on a 409).
    const committedThisAttempt: Resolved[] = []
    const now = new Date().toISOString()
    const next = current.map((row) => {
      const match = matchByRow.get(row)
      if (!match || row.enrollment_status === "enrolled") {
        return row
      }
      committedThisAttempt.push(match)
      // Fill-missing: keep teacher-entered values, fall back to the student's
      // self-reported name/email.
      return normalizeStudentRow({
        ...row,
        username: match.username,
        github_id: match.github_id,
        email: row.email || match.email,
        first_name: row.first_name || match.first_name,
        last_name: row.last_name || match.last_name,
        enrollment_status: "enrolled",
        enrolled_at: now,
      })
    })

    if (committedThisAttempt.length === 0) {
      // Nothing new to write (e.g. every match already enrolled); skip the
      // commit and clear committed so cleanup touches nothing.
      committed = []
      return
    }

    const nextCsv = stringifyStudentsCsv(next)

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
        `Reconcile onboarding: ${classroom} (${committedThisAttempt.length} student${
          committedThisAttempt.length === 1 ? "" : "s"
        })`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })

    await updateRef(client, org, newCommit.sha)
    committed = committedThisAttempt
  })

  // Best-effort fallback team-add for read on private in-org templates. Both
  // invite flows already attach team_ids to the org invitation, so an accepted
  // student is usually on the team before reconcile; this still covers an invite
  // that predated team_ids or whose membership hadn't activated. Non-fatal (row
  // already landed). Resolve the slug once; on failure, skip team adds but still
  // proceed to cleanup.
  let teamSlug: string | undefined
  try {
    teamSlug = await resolveClassroomTeamSlug(client, org, classroom)
  } catch (err) {
    result.unmatched.push({
      repo: "(team)",
      reason: `reconciled, but resolving the classroom team failed (${getErrorMessage(err)}); team membership not added`,
    })
  }

  if (teamSlug) {
    for (const { username } of committed) {
      const added = await tryAddUserToTeam(
        client,
        { org, teamSlug, username },
        "reconcile team add",
      )
      if (!added.ok) {
        result.unmatched.push({
          repo: `(team:${username})`,
          reason: `reconciled, but adding to the classroom team failed (${added.detail})`,
        })
      }
    }
  }

  // Cleanup runs ONLY after the CSV commit succeeded, for committed repos PLUS
  // redundant duplicate repos. A repo whose write didn't land, or whose row was
  // already enrolled, is never touched. Mode is per-classroom (default
  // "delete"); failures non-fatal. Never touch unmatched/pending.
  const reposToCleanup = [
    ...committed.map((c) => c.repo),
    ...redundantRepos,
  ].filter((repo) => repo.length > 0)
  if (cleanupMode !== "keep" && reposToCleanup.length > 0) {
    let deleteScopeMissing = false

    for (const repo of reposToCleanup) {
      // "delete" needs the delete_repo scope (an older session's token may lack
      // it); on a 403 fall back to archiving and warn once to re-authorize.
      if (cleanupMode === "delete" && !deleteScopeMissing) {
        try {
          await deleteRepo(client, { owner: org, repo })
          result.deleted.push(repo)
          continue
        } catch (err) {
          if (err instanceof GitHubAPIError && err.isForbidden) {
            deleteScopeMissing = true
            // fall through to archive
          } else {
            result.unmatched.push({
              repo,
              reason: `reconciled but delete failed: ${getErrorMessage(err)}`,
            })
            continue
          }
        }
      }

      try {
        await archiveRepo(client, { owner: org, repo })
        result.archived.push(repo)
      } catch (err) {
        result.unmatched.push({
          repo,
          reason: `reconciled but archive failed: ${getErrorMessage(err)}`,
        })
      }
    }

    if (deleteScopeMissing) {
      result.cleanupWarning =
        "Cleanup is set to delete, but your current session isn't authorized to " +
        "delete repositories, so the onboarding repos were archived instead. " +
        "Sign out and back in to grant the delete permission, or change the " +
        "classroom cleanup setting to archive."
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

export type MarkStudentEnrolledInput = {
  org: string
  classroom: string
  username: string
  github_id?: string
}

// Teacher-initiated confirm for a verified live org member with no onboarding
// repo (reconcile can't confirm those). Re-verifies active membership before
// writing, so a non-member can't be bound (#65; keeps the #50 trust model).
async function markStudentEnrolled(
  client: GitHubClient,
  input: MarkStudentEnrolledInput,
) {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)

  const normalizedUsername = input.username.trim()
  if (!normalizedUsername) {
    throw new Error("GitHub username is required")
  }

  // Authoritative member re-check (the UI gates on a cached member set; this is
  // the real guard). Only an active member can be marked enrolled.
  const state = await getOrgMembershipState(client, org, normalizedUsername)
  if (state !== "active") {
    throw new Error(
      `${normalizedUsername} is not an active member of the ${org} organization, so they can't be marked enrolled.`,
    )
  }

  const ref = await getBranchRef(client, org)
  const commit = await getCommit(client, org, ref.object.sha)
  const studentsFilePath = `${classroom}/students.csv`
  const currentCsv = await getRawFile(client, {
    org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })
  const currentStudents = parseStudentsCsv(currentCsv)

  // Match the target row by username or github_id (mirrors unenroll's predicate).
  const sameRow = (student: StudentCsvRow) =>
    student.username.toLowerCase() === normalizedUsername.toLowerCase() ||
    (Boolean(input.github_id) &&
      Boolean(student.github_id) &&
      student.github_id === input.github_id)

  const target = currentStudents.find(sameRow)
  if (!target) {
    throw new Error(`Student ${normalizedUsername} does not exist in roster!`)
  }

  if (target.enrollment_status === "enrolled") {
    // Already enrolled — nothing to write; treat as success (idempotent).
    return { alreadyEnrolled: true, student: target }
  }

  const now = new Date().toISOString()
  const enrolledRow = normalizeStudentRow({
    ...target,
    enrollment_status: "enrolled",
    enrolled_at: now,
  })
  const nextStudents = currentStudents.map((student) =>
    sameRow(student) ? enrolledRow : student,
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
      `Mark student enrolled: ${classroom}/${enrolledRow.username}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  await updateRef(client, org, newCommit.sha)

  return { alreadyEnrolled: false, student: enrolledRow }
}

export async function markStudentEnrolledWithConflictRetry(
  client: GitHubClient,
  input: MarkStudentEnrolledInput,
) {
  const result = await withGitConflictRetry(() =>
    markStudentEnrolled(client, input),
  )

  // Best-effort: ensure the now-enrolled member is on the classroom team (read
  // on private templates). Non-fatal — the roster write already landed.
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
        "mark enrolled",
      )
      if (!added.ok) {
        teamWarning =
          `${result.student.username} was marked enrolled, but adding them to the ` +
          `classroom team failed; they won't have read on private templates until ` +
          `it's retried.`
      }
    }
  } catch (err) {
    console.error("team resolve failed (mark enrolled):", err)
    teamWarning =
      `${result.student.username} was marked enrolled, but adding them to the ` +
      `classroom team failed; they won't have read on private templates until ` +
      `it's retried.`
  }

  return { ...result, teamWarning }
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
// account is an ACTIVE member before binding (same #65/#50 trust model as
// markStudentEnrolled), so a wrong/stale pick can't bind a non-member.
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

  if (target.enrollment_status === "enrolled") {
    return { alreadyEnrolled: true, student: target }
  }

  const now = new Date().toISOString()
  const matchedRow = normalizeStudentRow({
    ...target,
    username: normalizedUsername,
    github_id: input.github_id.trim(),
    enrollment_status: "enrolled",
    enrolled_at: now,
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
        // Still onboards to supply name/email; reconcile flips to "enrolled".
        // Cache email_hash when GitHub exposes a public email.
        enrollment_status: "invited",
        enrollment_method: "github",
        email_hash: studentEmail ? await emailHash(studentEmail) : "",
        // Unique per-student invite token so a secure onboarding link always
        // exists (reconcile's strongest match key; else github_id / email).
        invite_token: generateInviteToken(),
        invited_at: new Date().toISOString(),
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

  // Reset onboarding for a not-yet-reconciled student: delete their onboarding
  // repo so a re-invite starts clean. Repo name is `onboarding-<github-id>`,
  // fully derivable, so we list the org's onboarding repos and delete the one
  // matching that exact name. An email-only row has no targetable name; its repo
  // is cleaned at the next reconcile. Best-effort, idempotent (404 = gone); a
  // failed delete falls back to archive.
  if (
    toRemoveStudent.enrollment_status !== "enrolled" &&
    toRemoveStudent.github_id
  ) {
    const name = onboardingRepoName(toRemoveStudent.github_id)
    let onboardingRepos: string[] = []
    try {
      onboardingRepos = (await listOnboardingRepos(client, org))
        .map((repo) => repo.name)
        .filter((repoName) => repoName === name)
    } catch {
      // Best-effort reset: if listing fails, skip repo cleanup.
    }
    for (const onboardingRepo of onboardingRepos) {
      try {
        await deleteRepo(client, { owner: org, repo: onboardingRepo })
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isForbidden) {
          // No delete permission (older session): archive instead so the repo
          // is no longer a live onboarding target.
          try {
            await archiveRepo(client, { owner: org, repo: onboardingRepo })
          } catch {
            // ignore — best-effort reset
          }
        }
        // Other errors (incl. 404 handled inside deleteRepo) are non-fatal.
      }
    }
  }

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

// The teacher-editable subset of a roster row. Identity (username, github_id)
// and lifecycle columns (enrollment_status/method, invite_token, timestamps)
// are deliberately excluded — they're bound by onboarding/reconcile, not the
// teacher.
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
// students.csv. Identity + lifecycle columns are preserved verbatim from the
// matched row. Recomputes email_hash when the email changes so email-based
// reconcile matching stays correct.
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

  // Before enrollment is confirmed, the email is part of the identity that
  // onboarding/reconcile binds (email-based match key). Letting the teacher
  // override it pre-enrollment could break that match, so refuse any email
  // change until the row is enrolled. The UI locks the field too (shared
  // isEnrolledRow predicate); this is the server-side backstop.
  if (emailChanged && !isEnrolledRow(existing)) {
    throw new Error(
      "Can't change the email before enrollment is confirmed: it's part of " +
        "the identity onboarding binds. Confirm enrollment first, then edit.",
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

  // Recompute the cached hash only when the email changed (a cleared email
  // clears it), so an unchanged email keeps its stored hash without drift.
  let nextEmailHash = existing.email_hash
  if (emailChanged) {
    nextEmailHash = nextEmail ? await emailHash(nextEmail) : ""
  }

  // Spread the existing row so every identity/lifecycle column is preserved,
  // then overwrite only the four editable fields.
  const updatedStudent = normalizeStudentRow({
    ...existing,
    first_name: patch.first_name,
    last_name: patch.last_name,
    email: nextEmail,
    section: patch.section,
    email_hash: nextEmailHash,
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
