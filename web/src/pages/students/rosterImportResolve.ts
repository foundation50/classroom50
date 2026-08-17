import { getUserById } from "@/github-core/queries"
import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { logger } from "@/lib/logger"
import type { ClassroomRole } from "@/util/teamRoster"
import type { ParsedImportRow } from "@/pages/students/rosterImportParse"

const log = logger.scope("students:rosterImportResolve")

// How many unknown ids we'll trade for a current login over the network during a
// preview. The local org-member map covers every enrolled student for free, so this
// only bounds the tail: ids for accounts that have left the org, or an export from
// another system. Sized so a whole cohort imported by github_id into a fresh
// organization still previews — a row past the cap can't be imported at all (it is
// never silently re-keyed to its username cell), so a stingy cap would refuse a
// legitimate file outright rather than merely slowing it down.
export const ID_RESOLUTION_CAP = 200

// Lookups in flight at once. Enough that the cap is a handful of round-trips
// rather than hundreds, small enough not to burst into GitHub's secondary rate
// limits — which throttle concurrency, not just total volume.
const ID_RESOLUTION_BATCH = 10

// A row's resolved identity. `account` addresses a GitHub account (the login is
// authoritative once resolved); `email` addresses someone with no account on file
// yet and routes to an email invitation.
export type ImportIdentity =
  | {
      kind: "account"
      username: string
      github_id?: string
      // The username the FILE claimed, when a github_id resolved to a different
      // login. Present only on a genuine disagreement, and it is what gates the
      // import behind a confirmation.
      declaredUsername?: string
      // True when this row's login came from a github_id rather than a username
      // cell, so the preview can force the resolved handle into view.
      resolvedFromId?: boolean
    }
  | { kind: "email"; email: string }

export type ResolvedImportRow = {
  identity: ImportIdentity
  first_name?: string
  last_name?: string
  email?: string
  section?: string
  role?: ClassroomRole
}

type AccountIdentity = Extract<ImportIdentity, { kind: "account" }>
type AccountImportRow = ResolvedImportRow & { identity: AccountIdentity }
type EmailImportRow = ResolvedImportRow & {
  identity: Extract<ImportIdentity, { kind: "email" }>
}

// Narrowing predicates, so a caller that filters by identity kind gets the
// narrowed row type instead of re-asserting it at every use. A cast would
// silently survive a change to ImportIdentity; these don't.
export const isAccountRow = (r: ResolvedImportRow): r is AccountImportRow =>
  r.identity.kind === "account"
export const isEmailRow = (r: ResolvedImportRow): r is EmailImportRow =>
  r.identity.kind === "email"

// A row excluded from the import, with enough detail for the preview to name the
// line the teacher has to edit. `unresolved-id` means the file's github_id is not
// usable — malformed, or no such account. `id-lookup-failed` means we could not
// ASK: a rate limit, a 5xx, an SSO-gated 403. `id-lookup-capped` means we CHOSE
// not to ask, having already spent ID_RESOLUTION_CAP lookups on this file. All
// three fail closed (the row is never re-keyed to its username cell), but they
// need different advice: a file to fix, a retry, and a file too big to check in
// one pass — where a retry would deterministically fail, so it must not be
// suggested.
export type UnusableRow = {
  line: number
  reason: "unresolved-id" | "id-lookup-failed" | "id-lookup-capped"
  githubId: string
  username?: string
}

export type ResolvedImportFile = {
  rows: ResolvedImportRow[]
  unusable: UnusableRow[]
}

// A stable key per identity for dedupe and for keying the modal's per-row state.
// Account rows key on the RESOLVED login, not the id: after resolution the login
// is authoritative, so keying on it is what lets a `github_id` row and a
// `username` row naming the same person collapse into one. Email rows key on the
// normalized address. One helper so the preview table, the role map, and the
// dedupe pass can never disagree.
//
// Deliberately not `studentKey` from util/identity: that keys a STORED row
// id-first, which would split the two rows this one is meant to collapse.
export const identityKey = (identity: ImportIdentity): string =>
  identity.kind === "email"
    ? `email:${identity.email}`
    : `login:${identity.username.toLowerCase()}`

// The key a login alone maps to, for a caller holding a username rather than a
// whole identity. Goes through identityKey so the format lives in one place.
export const loginIdentityKey = (username: string): string =>
  identityKey({ kind: "account", username })

// Resolve each parsed row's identity cells into an addressable identity, in
// precedence order github_id > username > email. An id is traded for its CURRENT
// login: locally against the org-member map first (free), then over the network
// for the bounded tail. An id we cannot resolve fails closed — see UnusableRow.
//
// Rows are deduped here (not in the parser) because two rows can only be known
// to name the same person once ids resolve. First occurrence wins, so its
// metadata is kept.
export async function resolveImportIdentities(
  client: GitHubClient,
  rows: ParsedImportRow[],
  loginById: ReadonlyMap<number, string>,
): Promise<ResolvedImportFile> {
  const resolvedLogins = new Map<number, string>(loginById)
  // Ids GitHub told us don't exist, vs. ids we couldn't ask about (rate limit,
  // 5xx, SSO). Both keep their row out of the import, but only the first is the
  // teacher's file to fix.
  const missingIds = new Set<number>()
  const unaskedIds = new Set<number>()
  // Ids we skipped because the file exhausted the lookup budget. Distinct from
  // unasked: a retry can fix a rate limit, but the cap is deterministic, so
  // telling the teacher to try again would be a dead end.
  const cappedIds = new Set<number>()

  // Only ids absent from the local map cost a request. Deduped first so a file
  // listing the same id twice spends one call, and capped so a large import from
  // another system can't fan out without bound.
  const unknownIds = [
    ...new Set(
      rows
        .map((row) => row.identity.githubId)
        .filter(
          (id): id is number => id !== undefined && !resolvedLogins.has(id),
        ),
    ),
  ]

  for (const id of unknownIds.slice(ID_RESOLUTION_CAP)) cappedIds.add(id)

  // Resolve in bounded-concurrency batches rather than one id at a time: a preview
  // blocks on this, and a serial walk of the cap would be that many round-trips
  // deep. A batch also gives the rate-limit stop a natural checkpoint — once
  // GitHub pushes back, every remaining id is reported unasked instead of spending
  // the rest of the budget re-learning the same thing.
  let stopped = false
  const askable = unknownIds.slice(0, ID_RESOLUTION_CAP)
  for (let i = 0; i < askable.length; i += ID_RESOLUTION_BATCH) {
    if (stopped) {
      for (const id of askable.slice(i)) unaskedIds.add(id)
      break
    }
    const batch = askable.slice(i, i + ID_RESOLUTION_BATCH)
    await Promise.all(
      batch.map(async (id) => {
        try {
          const user = await getUserById(client, id)
          resolvedLogins.set(id, user.login)
        } catch (err) {
          if (err instanceof GitHubAPIError && err.isNotFound) {
            missingIds.add(id)
            return
          }
          // Anything else (rate limit, 5xx, SSO-gated 403) says nothing about
          // whether the account exists, so don't tell the teacher their id is
          // wrong. A rate limit also means every remaining lookup would fail, so
          // stop after this batch.
          unaskedIds.add(id)
          if (err instanceof GitHubAPIError && err.isRateLimited) stopped = true
          log.warn("id resolution failed", { id, err })
        }
      }),
    )
  }

  const rowsOut: ResolvedImportRow[] = []
  const unusable: UnusableRow[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const { githubId, malformedGithubId, username, email } = row.identity
    const metadata = {
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      section: row.section,
      role: row.role,
    }

    // A cell that isn't a canonical id at all — see UnusableRow.
    if (malformedGithubId !== undefined) {
      unusable.push({
        line: row.line,
        reason: "unresolved-id",
        githubId: malformedGithubId,
        username,
      })
      continue
    }

    let identity: ImportIdentity
    if (githubId !== undefined) {
      const login = resolvedLogins.get(githubId)
      if (!login) {
        unusable.push({
          line: row.line,
          // missingIds, unaskedIds and cappedIds are disjoint by construction:
          // capped ids are sliced out of `askable`, and each askable id lands
          // in exactly one of resolved / missing / unasked.
          reason: cappedIds.has(githubId)
            ? "id-lookup-capped"
            : unaskedIds.has(githubId)
              ? "id-lookup-failed"
              : "unresolved-id",
          githubId: String(githubId),
          username,
        })
        continue
      }
      const disagrees =
        username !== undefined && username.toLowerCase() !== login.toLowerCase()
      identity = {
        kind: "account",
        username: login,
        github_id: String(githubId),
        resolvedFromId: true,
        ...(disagrees ? { declaredUsername: username } : {}),
      }
    } else if (username !== undefined) {
      identity = { kind: "account", username }
    } else if (email !== undefined) {
      identity = { kind: "email", email }
    } else {
      // Unreachable: the parser never emits an identity-less row (hasAnyIdentity
      // gates it) — such a row is dropped as `incomplete` with its line number
      // before resolution, so there is nothing left to report here.
      continue
    }

    const key = identityKey(identity)
    if (seen.has(key)) continue
    seen.add(key)
    rowsOut.push({ identity, ...metadata })
  }

  return { rows: rowsOut, unusable }
}
