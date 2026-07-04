import type { GitHubClient } from "@/hooks/github/client"
import { bulkEnrollStudentsInClassroom } from "@/api/mutations/students"
import type { BulkEnrollStudentsResult } from "@/api/mutations/students"
import { getUserById } from "@/hooks/github/queries"
import { isActiveMember } from "@/hooks/github/mutations"
import { parseGitHubId } from "@/util/students"
import type { GitHubUser } from "@/hooks/github/types"
import type { OrgMemberRow } from "@/util/orgMembers"

// Per-row outcome of resolving a selection to a placeable current login BEFORE
// the enroll engine runs. `skipped` covers the rows we intentionally don't send
// (not a live member, no id to resolve, already on the target classroom).
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
  // The enroll engine's result (added / skipped-by-csv / per-student team
  // results), null when nothing was eligible to send.
  enroll: BulkEnrollStudentsResult | null
  // Rows we filtered out before the engine (with why), so the UI can report
  // them alongside the engine's own duplicate/team skips.
  preSkipped: BulkAddSkip[]
}

const labelFor = (row: OrgMemberRow) => row.username || row.email || row.key

// Place selected org members into a classroom's team + roster in one bulk
// action. Composition-only over the existing engine:
//   1. Pre-filter to rows that look like members in the already-loaded org-member
//      list (numeric id, or login fallback) — a cheap gate that avoids a live
//      read for the obvious non-members, and the SAML "place existing members"
//      requirement (we never invite from here).
//   2. Skip rows already on the target classroom (by CSV-derived access).
//   3. Resolve each remaining row to its CURRENT login via the immutable
//      github_id (stored usernames go stale), then RE-VERIFY the account is a
//      live ACTIVE member (the loaded list can be up to its staleTime old; a
//      since-removed member must not be enrolled, or the engine would still
//      write a CSV roster row for a non-member — a drift row).
//   4. Hand the surviving logins to bulkEnrollStudentsInClassroom, which is
//      itself idempotent (skips CSV duplicates; addUserToTeam is a PUT).
//
// The engine commits the roster append first, then best-effort team-adds each
// student, returning per-student teamResults + skips — so a partial team
// failure never rejects the whole batch. We surface both our pre-skips and the
// engine's results to the caller.
export async function bulkAddToClassroom(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    rows: OrgMemberRow[]
    // The org's live members, already loaded by the page — the trust anchor for
    // "is this selection a real member" without an extra read per row.
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
  // Rows that pass the member/duplicate gates, paired with the immutable id we
  // resolve their current login from.
  const toResolve: { row: OrgMemberRow; matchedId: string }[] = []

  for (const row of rows) {
    // Already on the target classroom (CSV-derived): nothing to do. The engine
    // would skip it anyway, but reporting it here is clearer and saves a lookup.
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

    // Not a live active member -> never invite from here (SAML-safe: we only
    // place existing members). Send them to the row's invite affordance instead.
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
  // member list can be stale, and enrolling a since-removed account would write
  // a CSV drift row. A row whose id no longer resolves, or is no longer an
  // active member, is skipped rather than enrolled.
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
      // resolve failure rather than trusting a possibly-stale username.
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
    } catch {
      preSkipped.push({
        key: row.key,
        label: labelFor(row),
        reason: "resolve-failed",
      })
      resolved++
      continue
    }
    // Authoritative membership re-check on the resolved current login. A read
    // failure resolves to false (isActiveMember never throws), so we fail safe:
    // an unverifiable account is not enrolled.
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
