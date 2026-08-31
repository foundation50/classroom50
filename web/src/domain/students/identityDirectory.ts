// The classroom identity directory: a read-only union of every classroom's
// team members plus every roster's email→identity mappings, used to resolve
// uploaded email addresses to GitHub accounts and to feed username pickers.
// Deliberately classroom-team-scoped, NOT the org member list — a shared org
// contains other teachers' members.

import type { GitHubClient } from "@/github-core/client"
import { getConfigRepoBranch } from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import {
  getRawFile,
  listClassroomDirs,
  listTeamMembers,
  REPO_READ_CONCURRENCY,
} from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { parseGitHubId } from "@/util/identity"
import { normalizeInviteEmail } from "@/util/inviteTeam"
import { parseRosterCsv } from "@/util/rosterCsv"
import { rosterPath } from "@/util/rosterPath"
import { resolveClassroomTeamSlugs } from "./rosterPrimitives"

export type DirectoryMember = {
  id: number
  login: string
  // Classrooms this account was seen in (team membership), first-seen order.
  classrooms: string[]
}

export type DirectoryIdentity = {
  id: number
  login: string
  // The classroom whose roster recorded the mapping (first seen).
  classroom: string
}

export type IdentityDirectory = {
  // Normalized email -> the unique identity that address maps to, or
  // "ambiguous" when two different ids claim it across rosters.
  byEmail: Map<string, DirectoryIdentity | "ambiguous">
  // Deduped member pool (by id) across all classroom teams, for pickers.
  members: DirectoryMember[]
  // True when any classroom read failed: what WAS read is still usable
  // (decision-time verification is the caller's real gate), but callers
  // surface the degradation.
  degraded: boolean
}

// One classroom's best-effort scan, folded deterministically afterwards.
type ClassroomScan = {
  classroom: string
  members: { id: number; login: string }[]
  rows: { email: string; id: number; login: string }[]
  failed: boolean
}

const emptyDirectory = (degraded: boolean): IdentityDirectory => ({
  byEmail: new Map(),
  members: [],
  degraded,
})

// Build the directory by walking every classroom's teams and roster. Reads are
// best-effort per classroom (one bad classroom sets `degraded`, never blocks
// the rest); an unreadable classroom listing yields an empty degraded
// directory rather than throwing.
//
// Login drift: byEmail logins come from possibly-stale roster cells, so
// callers must re-resolve the CURRENT login via getUserById at decision time
// and never trust the stored login as identity — the numeric id is identity;
// the login is display-only.
export async function buildIdentityDirectory(
  client: GitHubClient,
  org: string,
): Promise<IdentityDirectory> {
  let classrooms: string[]
  let branch: string
  try {
    const dirs = await listClassroomDirs(client, org)
    classrooms = dirs.map((d) => d.name).toSorted((a, b) => a.localeCompare(b))
    // One branch resolve for every roster read below, not one per classroom.
    branch = await getConfigRepoBranch(client, org)
  } catch {
    return emptyDirectory(true)
  }

  // A rate limit dooms every request the remaining scans would issue, so the
  // first rate-limited scan stops the pool: later scans mark themselves failed
  // (-> degraded) without touching the API (mirrors collectInviteRecoveries).
  let rateLimited = false
  const scans = await mapWithConcurrency(
    classrooms,
    REPO_READ_CONCURRENCY,
    async (classroom): Promise<ClassroomScan> => {
      const scan: ClassroomScan = {
        classroom,
        members: [],
        rows: [],
        failed: false,
      }
      if (rateLimited) {
        scan.failed = true
        return scan
      }
      try {
        const slugs = await resolveClassroomTeamSlugs(client, org, classroom)
        const teamSlugs = [
          slugs.student,
          slugs.staff.teacher,
          slugs.staff.hta,
          slugs.staff.ta,
        ]
        // listTeamMembers already 404-tolerates a missing team to [].
        const memberLists = await Promise.all(
          teamSlugs.map((slug) => listTeamMembers(client, org, slug)),
        )
        for (const list of memberLists) {
          for (const m of list) scan.members.push({ id: m.id, login: m.login })
        }

        let csv: string | null = null
        try {
          csv = await getRawFile(client, {
            org,
            path: rosterPath(classroom),
            ref: branch,
          })
        } catch (err) {
          // A missing roster.csv is a normal state (no mappings), not degradation.
          if (!(err instanceof GitHubAPIError && err.isNotFound)) throw err
        }
        if (csv !== null) {
          // Tolerant parse: usable rows still count even next to malformed ones.
          const { rows } = parseRosterCsv(csv)
          for (const row of rows) {
            const email = normalizeInviteEmail(row.email)
            const id = parseGitHubId(row.github_id)
            // Recycled-login rule: only a row carrying a usable numeric id is an
            // identity; the login is carried for display only (may be "").
            if (!email || id === null) continue
            scan.rows.push({ email, id, login: row.username.trim() })
          }
        }
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
        }
        scan.failed = true
      }
      return scan
    },
  )

  // mapWithConcurrency preserves input order, so folding the scans as-is keeps
  // the output deterministic (classroom-name order) regardless of completion order.
  const byEmail = new Map<string, DirectoryIdentity | "ambiguous">()
  const memberById = new Map<number, DirectoryMember>()
  let degraded = false
  for (const scan of scans) {
    if (scan.failed) degraded = true
    for (const m of scan.members) {
      const existing = memberById.get(m.id)
      if (existing) {
        if (!existing.classrooms.includes(scan.classroom)) {
          existing.classrooms.push(scan.classroom)
        }
      } else {
        memberById.set(m.id, {
          id: m.id,
          login: m.login,
          classrooms: [scan.classroom],
        })
      }
    }
    for (const row of scan.rows) {
      const existing = byEmail.get(row.email)
      if (existing === undefined) {
        byEmail.set(row.email, {
          id: row.id,
          login: row.login,
          classroom: scan.classroom,
        })
      } else if (existing !== "ambiguous") {
        if (existing.id !== row.id) {
          byEmail.set(row.email, "ambiguous")
        } else if (existing.login === "" && row.login !== "") {
          // Same identity again: keep the first-seen entry, but adopt a
          // displayable login the first roster cell was missing.
          existing.login = row.login
        }
      }
    }
  }

  const members = [...memberById.values()].toSorted((a, b) =>
    a.login.localeCompare(b.login),
  )
  return { byEmail, members, degraded }
}

// Widen a picker pool with the full org member list (an OPT-IN broadening:
// the directory pool stays the default because a shared org contains other
// teachers' members). Directory entries win a duplicate id — they carry the
// classrooms the account was seen in; an org-only member gets an empty list.
// Order is directory-first (unchanged), then org-only members by login, so
// classroom-known candidates surface before strangers.
export function mergeOrgMembersIntoPool(
  directoryMembers: DirectoryMember[],
  orgMembers: { id: number; login: string }[],
): DirectoryMember[] {
  const known = new Set(directoryMembers.map((m) => m.id))
  const orgOnly = orgMembers
    .filter((m) => !known.has(m.id))
    .map((m) => ({ id: m.id, login: m.login, classrooms: [] as string[] }))
    .toSorted((a, b) => a.login.localeCompare(b.login))
  return [...directoryMembers, ...orgOnly]
}
