import { getUserById } from "@/github-core/queries"
import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { logger } from "@/lib/logger"
import type { ClassroomRole } from "@/util/teamRoster"
import type { ParsedImportRow } from "@/pages/students/rosterImportParse"

const log = logger.scope("students:rosterImportResolve")

// How many unknown ids we'll trade for a current login over the network during a
// preview. The local org-member map covers every enrolled student for free, so
// this only bounds the tail: ids for accounts that have left the org, or an
// export from another system. Past the cap a row is reported, never silently
// re-keyed to its username cell.
export const ID_RESOLUTION_CAP = 25

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

// A row excluded from the import, with enough detail for the preview to say why.
// `unresolved-id` is the fail-closed case: the file carried a github_id we could
// not turn into a login, so we refuse to act on the row at all.
export type UnusableRow = {
  reason: "unresolved-id" | "no-identity"
  githubId?: string
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
export const identityKey = (identity: ImportIdentity): string =>
  identity.kind === "email"
    ? `email:${identity.email}`
    : `login:${identity.username.toLowerCase()}`

// Resolve each parsed row's identity cells into an addressable identity, in
// precedence order github_id > username > email.
//
// An id is traded for its CURRENT login: locally against the org-member map
// first (free), then over the network for the bounded tail. An id we cannot
// resolve FAILS CLOSED — the row is reported unusable rather than falling back to
// its username cell, because that fallback would send the org invite, and its
// repo access, to whoever holds that login today. inviteRosterStudents already
// refuses the same substitution for the same reason.
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
  const unresolvableIds = new Set<number>()

  // Only ids absent from the local map cost a request. Deduped first so a file
  // listing the same id twice spends one call, and capped so a large import from
  // another system can't fan out into hundreds of requests.
  const unknownIds = [
    ...new Set(
      rows
        .map((row) => row.identity.githubId)
        .filter(
          (id): id is number => id !== undefined && !resolvedLogins.has(id),
        ),
    ),
  ]

  let rateLimited = false
  for (const id of unknownIds.slice(0, ID_RESOLUTION_CAP)) {
    if (rateLimited) break
    try {
      const user = await getUserById(client, id)
      resolvedLogins.set(id, user.login)
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        // Stop issuing requests; every remaining id stays unresolved and its row
        // is reported rather than guessed at.
        rateLimited = true
        log.warn("id resolution rate limited", { id })
      } else {
        unresolvableIds.add(id)
        log.debug("id resolution failed", { id, err })
      }
    }
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

    // A cell that isn't a canonical id at all: unusable on its own terms, and we
    // don't quietly prefer the username cell instead.
    if (malformedGithubId !== undefined) {
      unusable.push({
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
          reason: "unresolved-id",
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
      unusable.push({ reason: "no-identity" })
      continue
    }

    const key = identityKey(identity)
    if (seen.has(key)) continue
    seen.add(key)
    rowsOut.push({ identity, ...metadata })
  }

  return { rows: rowsOut, unusable }
}
