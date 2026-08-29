import type { GitHubClient } from "@/github-core/client"
import { readOrgMembershipState } from "@/github-core/mutations"
import { normalizeInviteEmail } from "@/util/inviteTeam"
import { normalizeStudentRow, type StudentCsvRow } from "@/util/rosterCsv"
import { assertClassroomNotArchived } from "../classrooms"
import { pendingInviteEmails } from "./inviteRecoveries"
import { assignRosterMemberRole } from "./roleWrites"
import { withRosterRewrite, log } from "./rosterPrimitives"

// Manual reconciliation for UNLINKED roster rows — rows with no GitHub
// identity that the roster preserves (a name-only row, or an email row the
// teacher explicitly kept). The teacher either links such a row to an org
// member (writing username + github_id onto it, then enrolling them on the
// classroom team) or deletes it. Both writes go through withRosterRewrite
// (conflict-retried, refuses a malformed file).

// Addresses one identity-less row by its own cells: the normalized email when
// the row carries one, else the (first_name, last_name, section) tuple. There
// is nothing better to key on — the row exists precisely because it has no
// identity — so an AMBIGUOUS match (two identical tuples) fails closed rather
// than guessing which twin the teacher meant.
export type UnlinkedRowRef = {
  email?: string
  first_name?: string
  last_name?: string
  section?: string
}

// Derive the ref for a row (the view passes its TeamRosterRow fields through
// this so the addressing rule lives in one place).
export function unlinkedRowRef(row: {
  email: string
  first_name: string
  last_name: string
  section: string
}): UnlinkedRowRef {
  const email = normalizeInviteEmail(row.email)
  if (email) return { email }
  return {
    first_name: row.first_name.trim(),
    last_name: row.last_name.trim(),
    section: row.section.trim(),
  }
}

// The name-tuple comparison key: trimmed and lowercased, so matching and the
// append-time dedupe below can't disagree on what "the same tuple" means.
function tupleKey(row: {
  first_name?: string
  last_name?: string
  section?: string
}): string {
  return [row.first_name, row.last_name, row.section]
    .map((part) => (part ?? "").trim().toLowerCase())
    .join("|")
}

// The rows a ref addresses. Only rows with NO identity cells at all qualify
// (the same predicate that renders a row as unlinked), so a row that gained an
// identity since the view snapshot can never be matched — the action simply
// misses and reports it.
function matchUnlinkedRows(
  rows: StudentCsvRow[],
  ref: UnlinkedRowRef,
): number[] {
  const wantEmail = normalizeInviteEmail(ref.email ?? "")
  const indices: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.username.trim() || row.github_id.trim()) continue
    if (wantEmail) {
      if (normalizeInviteEmail(row.email) === wantEmail) indices.push(i)
      continue
    }
    // A tuple ref only ever comes from an email-less row; requiring the match
    // to be email-less too keeps it from grabbing a kept email row that
    // happens to share the name.
    if (row.email.trim()) continue
    if (tupleKey(row) === tupleKey(ref)) indices.push(i)
  }
  return indices
}

// The row a link targets is gone (already linked, deleted, or edited away).
export class UnlinkedRowNotFoundError extends Error {
  constructor() {
    super("No matching unlinked roster row")
    this.name = "UnlinkedRowNotFoundError"
  }
}

// Two identical identity-less rows match the ref — which one the teacher meant
// is not this code's guess. Remove (or edit) one of the twins first.
export class UnlinkedRowAmbiguousError extends Error {
  constructor() {
    super("More than one unlinked roster row matches")
    this.name = "UnlinkedRowAmbiguousError"
  }
}

// The chosen account is not (or no longer) an active org member, so there is
// nothing to link to yet — invite them first.
export class MemberNotActiveError extends Error {
  login: string
  constructor(login: string) {
    super(`${login} is not an active organization member`)
    this.name = "MemberNotActiveError"
    this.login = login
  }
}

// The chosen member already claims another roster row; linking would give one
// account two rows.
export class MemberAlreadyOnRosterError extends Error {
  login: string
  constructor(login: string) {
    super(`${login} already has a roster row`)
    this.name = "MemberAlreadyOnRosterError"
    this.login = login
  }
}

export type LinkRosterRowResult = {
  student: StudentCsvRow
  // The classroom-team half's outcome. Non-"ok" is non-fatal: the row was
  // linked either way, and a missing team add degrades to a needs-attention
  // row whose existing assign flow retries it. A discriminant (not prose) so
  // the view owns the user-facing copy.
  teamAdd: "ok" | "left-org" | "failed"
}

// Link an unlinked roster row to an org member: write their identity onto the
// row (clearing the unlinked marker) in one conflict-retried commit, then
// enroll them on the classroom team. The roster commit comes FIRST — a linked
// row missing its team add degrades to a needs-attention row with a working
// retry affordance, whereas a team add without the row would make the
// auto-sync append a DUPLICATE identity row beside the still-unlinked one.
export async function linkRosterRowToMember(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    rowRef: UnlinkedRowRef
    member: { id: number; login: string }
  },
): Promise<LinkRosterRowResult> {
  const { org, classroom, rowRef, member } = input
  const login = member.login.trim()
  if (!login || !member.id) throw new Error("A member identity is required")
  await assertClassroomNotArchived(client, org, classroom)

  // Decision-time proof the picker's snapshot can't provide: the target must
  // still be an ACTIVE org member (a transient read failure propagates and the
  // teacher retries, rather than linking a row to someone who just left).
  // assignRosterMemberRole re-checks after the commit below — deliberate: this
  // read gates the roster WRITE, that one gates the team add.
  const state = await readOrgMembershipState(client, org, login)
  if (state !== "active") {
    throw new MemberNotActiveError(login)
  }

  let linked: StudentCsvRow | undefined
  await withRosterRewrite(client, { org, classroom }, (rows) => {
    const matches = matchUnlinkedRows(rows, rowRef)
    if (matches.length === 0) throw new UnlinkedRowNotFoundError()
    if (matches.length > 1) throw new UnlinkedRowAmbiguousError()
    const idKey = String(member.id)
    const loginKey = login.toLowerCase()
    const clash = rows.some(
      (row, idx) =>
        idx !== matches[0] &&
        (row.github_id.trim() === idKey ||
          row.username.trim().toLowerCase() === loginKey),
    )
    if (clash) throw new MemberAlreadyOnRosterError(login)

    const target = rows[matches[0]]
    const next = normalizeStudentRow({
      ...target,
      username: login,
      github_id: idKey,
    })
    linked = next
    return {
      nextStudents: rows.map((row, idx) => (idx === matches[0] ? next : row)),
      changed: 1,
      message: `Link roster row to ${login}: ${classroom}`,
    }
  })
  if (!linked) {
    // Unreachable — the mutate above either assigned it or threw — but it lets
    // the rest of the function use the value without non-null assertions.
    throw new UnlinkedRowNotFoundError()
  }

  // Enroll on the classroom team via the same path the needs-attention assign
  // uses. Best-effort: the row is committed either way, and a failure leaves a
  // retryable needs-attention row rather than an inconsistent roster.
  try {
    const assigned = await assignRosterMemberRole(client, {
      org,
      classroom,
      username: login,
      role: "student",
    })
    if (assigned.state === "not-member") {
      return { student: linked, teamAdd: "left-org" }
    }
  } catch (err) {
    log.error("link roster row: team add failed", { org, classroom, err })
    return { student: linked, teamAdd: "failed" }
  }
  return { student: linked, teamAdd: "ok" }
}

export type RemoveUnlinkedRowsResult = {
  removed: number
  // Refs that matched nothing removable (the row gained an identity mid-flight
  // or was already deleted) — reported, never guessed at.
  missed: number
}

// Batch-delete unlinked rows, one commit. Only rows that STILL qualify as
// unlinked are removed: identity-less AND not backed by a live invitation —
// re-proved at decision time with one pending-invitations read, so a row
// whose address was (re-)invited since the view snapshot is spared, and a row
// that gained an identity is missed. A FAILED invitations read fails closed:
// email-carrying targets are all missed (name-only rows have nothing to back
// them and stay removable). Identical duplicate rows matching one ref are all
// removed (they are indistinguishable by construction).
export async function removeUnlinkedRows(
  client: GitHubClient,
  input: { org: string; classroom: string; rowRefs: UnlinkedRowRef[] },
): Promise<RemoveUnlinkedRowsResult> {
  const { org, classroom, rowRefs } = input
  await assertClassroomNotArchived(client, org, classroom)
  let removed = 0
  let missed = 0
  if (rowRefs.length === 0) return { removed, missed }

  // Read once, outside the rewrite (the mutate closure is synchronous); a
  // conflict retry reuses it — the guard defends against a stale VIEW, and
  // milliseconds of invitation drift are within that tolerance.
  const livePending = rowRefs.some((ref) =>
    normalizeInviteEmail(ref.email ?? ""),
  )
    ? await pendingInviteEmails(client, org)
    : new Set<string>()

  await withRosterRewrite(client, { org, classroom }, (rows) => {
    removed = 0
    missed = 0
    const removable = (row: StudentCsvRow) => {
      const email = normalizeInviteEmail(row.email)
      if (!email) return true
      return livePending !== null && !livePending.has(email)
    }
    const drop = new Set<number>()
    for (const ref of rowRefs) {
      const matches = matchUnlinkedRows(rows, ref).filter(
        (i) => removable(rows[i]) && !drop.has(i),
      )
      if (matches.length === 0) {
        missed++
        continue
      }
      for (const i of matches) drop.add(i)
    }
    removed = drop.size
    return {
      nextStudents: rows.filter((_, idx) => !drop.has(idx)),
      changed: removed,
      message: `Remove ${removed} unlinked roster row${removed === 1 ? "" : "s"}: ${classroom}`,
    }
  })
  return { removed, missed }
}

// One row the roster upload keeps as UNLINKED: teacher-supplied metadata with
// no GitHub identity — a name-only SIS row, or an email row whose invitation
// could not be sent (already a member, or the send failed).
export type UnlinkedRowInput = {
  first_name?: string
  last_name?: string
  email?: string
  section?: string
}

// Append unlinked rows in ONE commit. Best-effort and never throws (the
// upload's roster write already landed; a missed row is re-uploadable), and
// idempotent for re-runs: an entry whose email any row already claims — or
// whose name tuple an existing identity-less row already carries — is skipped
// rather than duplicated. Returns how many rows were actually written.
export async function appendUnlinkedRows(
  client: GitHubClient,
  input: { org: string; classroom: string },
  entries: UnlinkedRowInput[],
): Promise<number> {
  const usable = entries.filter(
    (e) =>
      normalizeInviteEmail(e.email ?? "") ||
      e.first_name?.trim() ||
      e.last_name?.trim(),
  )
  if (usable.length === 0) return 0
  let written = 0
  try {
    await withRosterRewrite(client, input, (rows) => {
      written = 0
      const claimedEmails = new Set(
        rows.map((r) => normalizeInviteEmail(r.email ?? "")).filter(Boolean),
      )
      const claimedTuples = new Set(
        rows
          .filter((r) => !r.username.trim() && !r.github_id.trim())
          .map((r) => tupleKey(r)),
      )
      const added: StudentCsvRow[] = []
      for (const entry of usable) {
        const email = normalizeInviteEmail(entry.email ?? "")
        if (email) {
          if (claimedEmails.has(email)) continue
          claimedEmails.add(email)
        } else {
          const key = tupleKey(entry)
          if (claimedTuples.has(key)) continue
          claimedTuples.add(key)
        }
        added.push(
          normalizeStudentRow({
            username: "",
            github_id: "",
            first_name: entry.first_name?.trim() ?? "",
            last_name: entry.last_name?.trim() ?? "",
            email,
            section: entry.section?.trim() ?? "",
            role: "",
          }),
        )
      }
      written = added.length
      return {
        nextStudents: [...rows, ...added],
        changed: added.length,
        message: `Keep ${added.length} unlinked roster row${
          added.length === 1 ? "" : "s"
        }: ${input.classroom}`,
      }
    })
  } catch (err) {
    log.error("unlinked roster row write failed", {
      org: input.org,
      classroom: input.classroom,
      err,
    })
    return 0
  }
  return written
}
