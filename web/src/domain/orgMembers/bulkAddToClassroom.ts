import type { GitHubClient } from "@/github-core/client"
import { bulkEnrollStudentsInClassroom } from "@/domain/students"
import type { BulkEnrollStudentsResult } from "@/domain/students"
import { getUserById } from "@/github-core/queries"
import { isActiveMember } from "@/github-core/mutations"
import { parseGitHubId } from "@/util/students"
import type { GitHubUser } from "@/github-core/types"
import type { OrgMemberRow } from "@/util/orgMembers"
import { logger } from "@/lib/logger"

const log = logger.scope("orgMembers:bulkAddToClassroom")

// Per-row outcome of resolving a selection to a placeable current login BEFORE
// the enroll engine runs. `skipped` = rows we intentionally don't send (not a
// live member, no id to resolve, already on the target classroom).
export type BulkAddSkip = {
  key: string
  label: string
  reason: "not-member" | "no-id" | "already-on-classroom" | "resolve-failed"
}

export type BulkAddProgress = {
  processed: number
  total: number
  message: string
}

export type BulkAddToClassroomResult = {
  // Enroll engine's result (added / skipped-by-csv / per-student team results);
  // null when nothing was eligible to send.
  enroll: BulkEnrollStudentsResult | null
  // Rows we filtered out before the engine (with why), reported alongside the
  // engine's own duplicate/team skips.
  preSkipped: BulkAddSkip[]
}

const labelFor = (row: OrgMemberRow) => row.username || row.email || row.key

// Place selected org members into a classroom's team + roster in one bulk
// action. Composition-only over the existing engine:
//   1. Pre-filter to rows that look like members in the already-loaded list
//      (numeric id, or login fallback) — a cheap gate, and enforces the SAML
//      "place existing members" rule (we never invite from here).
//   2. Skip rows already on the target classroom (by CSV-derived access).
//   3. Resolve each remaining row to its CURRENT login via the immutable
//      github_id (stored usernames go stale), then RE-VERIFY it's a live ACTIVE
//      member (the loaded list may be staleTime old; enrolling a since-removed
//      member would write a CSV drift row).
//   4. Hand surviving logins to bulkEnrollStudentsInClassroom (idempotent:
//      skips CSV duplicates; addUserToTeam is a PUT).
//
// The engine commits the roster append first, then best-effort team-adds each
// student, so a partial team failure never rejects the batch. We surface both
// our pre-skips and the engine's results.
export async function bulkAddToClassroom(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    rows: OrgMemberRow[]
    // The org's live members, already loaded by the page — the trust anchor for
    // "is this selection a real member" without a per-row read.
    members: GitHubUser[]
    onProgress?: (progress: BulkAddProgress) => void
  },
): Promise<BulkAddToClassroomResult> {
  const { org, classroom, rows, members, onProgress } = input

  const memberIds = new Set(members.map((m) => String(m.id)))
  const memberIdByLogin = new Map(
    members.map((m) => [m.login.toLowerCase(), String(m.id)]),
  )

  const preSkipped: BulkAddSkip[] = []
  // Rows passing the member/duplicate gates, paired with the immutable id we
  // resolve their current login from.
  const toResolve: { row: OrgMemberRow; matchedId: string }[] = []

  for (const row of rows) {
    // Already on the target classroom (CSV-derived): nothing to do. The engine
    // would skip it, but reporting here is clearer and saves a lookup.
    if (row.classrooms.some((c) => c.classroom === classroom)) {
      preSkipped.push({
        key: row.key,
        label: labelFor(row),
        reason: "already-on-classroom",
      })
      continue
    }

    const loginId = row.username
      ? memberIdByLogin.get(row.username.toLowerCase())
      : undefined
    const matchedId =
      row.github_id && memberIds.has(row.github_id)
        ? row.github_id
        : (loginId ?? null)

    // Not a live active member -> never invite from here (SAML-safe: place
    // existing members only). Send them to the row's invite affordance instead.
    if (!matchedId) {
      preSkipped.push({
        key: row.key,
        label: labelFor(row),
        reason: row.isMember ? "no-id" : "not-member",
      })
      continue
    }

    toResolve.push({ row, matchedId })
  }

  if (toResolve.length === 0) {
    return { enroll: null, preSkipped }
  }

  // Resolve current logins from the immutable id (usernames drift after a
  // rename), then re-verify LIVE active membership before enrolling — the loaded
  // list can be stale, and enrolling a since-removed account writes a CSV drift
  // row. A row whose id no longer resolves, or isn't an active member, is
  // skipped.
  const usernames: string[] = []
  let resolved = 0
  for (const { row, matchedId } of toResolve) {
    onProgress?.({
      processed: resolved,
      total: toResolve.length,
      message: `Resolving ${labelFor(row)}...`,
    })
    const id = parseGitHubId(matchedId)
    if (id === null) {
      // matchedId came from a live member, so this is unexpected; treat as a
      // resolve failure rather than trusting a maybe-stale username.
      preSkipped.push({
        key: row.key,
        label: labelFor(row),
        reason: "resolve-failed",
      })
      resolved++
      continue
    }
    let login: string
    try {
      login = (await getUserById(client, id)).login
    } catch (err) {
      log.debug("bulk add: id resolve failed, skipping row", { id, err })
      preSkipped.push({
        key: row.key,
        label: labelFor(row),
        reason: "resolve-failed",
      })
      resolved++
      continue
    }
    // Authoritative membership re-check on the resolved login. A read failure
    // resolves to false (isActiveMember never throws), so we fail safe: an
    // unverifiable account is not enrolled.
    if (!(await isActiveMember(client, org, login))) {
      preSkipped.push({
        key: row.key,
        label: labelFor(row),
        reason: "not-member",
      })
      resolved++
      continue
    }
    usernames.push(login)
    resolved++
  }

  if (usernames.length === 0) {
    return { enroll: null, preSkipped }
  }

  const enroll = await bulkEnrollStudentsInClassroom(client, {
    org,
    classroom,
    usernames,
    onProgress,
  })

  return { enroll, preSkipped }
}
