import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import type { GitHubUser } from "@/github-core/types"
import type { Student } from "@/types/classroom"
import { escapeCsvFormulaInjection } from "@/util/csv"
import { groupExportName } from "@/util/groupTeam"
import { resolveGitHubId } from "@/util/identity"
import { placeholderStudent, studentSortKeyByLastName } from "@/util/students"

// Header of the group-membership export. Hand-mirrored with NO compile-time
// link by contract.GroupMembershipCSVColumns (`gh teacher group list --csv`);
// `group` is the scores.json owner key and columns 4..10 are roster.csv's
// header verbatim, so the file joins to both without renaming.
export const GROUP_MEMBERSHIP_CSV_COLUMNS = [
  "group",
  "group_name",
  "team_slug",
  "repo",
  "username",
  "first_name",
  "last_name",
  "email",
  "section",
  "github_id",
  "role",
  "in_roster",
  "note",
] as const

type GroupMembershipCsvColumn = (typeof GROUP_MEMBERSHIP_CSV_COLUMNS)[number]
export type GroupMembershipCsvRow = Record<GroupMembershipCsvColumn, string>

// Mirrors contract.GroupMembershipNoteUnreadable.
export const GROUP_MEMBERSHIP_NOTE_UNREADABLE = "membership could not be read"

// A live member. `id` is the GitHub account id when the read carried one. A
// `fallback` member is derived from the repository name (a legacy founder),
// not from a live read: it is exported only when it resolves to a roster row
// or the group has no other member, so a founder who renamed their account
// does not reappear as a stranger beside their id-bearing collaborator entry.
export type GroupMember = { login: string; id?: number; fallback?: boolean }

export type GroupMembershipSource = {
  // The scores.json owner key: `group-<n>` (team) or the founder login (legacy).
  group: string
  name?: string
  teamSlug?: string
  repoName?: string
  // undefined when the live read failed, [] for a group with no members yet.
  members: readonly GroupMember[] | undefined
}

// Locale-independent natural order: case-folded code points, with digit runs
// compared as numbers (leading zeros ignored). Mirrors naturalLess in
// cli/gh-teacher/internal/groupcmd/rows.go so both exports list members in
// the same order in every locale; the UI keeps its locale-aware collation.
export function naturalCompare(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    const cx = x.codePointAt(i) as number
    const cy = y.codePointAt(j) as number
    if (isDigit(cx) && isDigit(cy)) {
      const [nx, ni] = leadingNumber(x, i)
      const [ny, nj] = leadingNumber(y, j)
      if (nx !== ny) {
        return nx.length !== ny.length
          ? nx.length - ny.length
          : nx < ny
            ? -1
            : 1
      }
      i = ni
      j = nj
      continue
    }
    if (cx !== cy) return cx - cy
    i += cx > 0xffff ? 2 : 1
    j += cy > 0xffff ? 2 : 1
  }
  return x.length - i - (y.length - j)
}

const isDigit = (cp: number) => cp >= 0x30 && cp <= 0x39

// The digit run at `from`, stripped of leading zeros ("0" for an all-zero
// run), and the index just past it.
function leadingNumber(s: string, from: number): [string, number] {
  let end = from
  while (end < s.length && isDigit(s.charCodeAt(end))) end++
  const digits = s.slice(from, end).replace(/^0+(?=\d)/, "")
  return [digits, end]
}

// Every group the submissions page knows, mode-neutral, for the export. Team
// mode lists every live team (including one with no repo or no members yet);
// legacy lists every existing group repo. Members keep their GitHub id so the
// export can join a renamed account to its roster row.
export function groupMembershipSources(input: {
  isTeamAssignment: boolean
  teamByOwner: ReadonlyMap<string, GroupTeamRef>
  teamMembersBySlug: ReadonlyMap<string, readonly GitHubUser[]>
  groupRepoList: readonly { owner: string; repoName: string }[]
  groupCollabByRepo: ReadonlyMap<string, readonly GitHubUser[]>
}): GroupMembershipSource[] {
  const repoByOwner = new Map(
    input.groupRepoList.map((repo) => [repo.owner, repo.repoName]),
  )
  if (input.isTeamAssignment) {
    return [...input.teamByOwner].map(([owner, team]) => ({
      group: owner,
      name: groupExportName(team),
      teamSlug: team.slug,
      repoName: repoByOwner.get(owner),
      members: input.teamMembersBySlug
        .get(team.slug)
        ?.map((m) => ({ login: m.login, id: m.id })),
    }))
  }
  return input.groupRepoList.map((repo) => {
    const collaborators = input.groupCollabByRepo.get(repo.repoName)
    return {
      group: repo.owner,
      repoName: repo.repoName,
      members: collaborators && [
        ...collaborators.map((m) => ({ login: m.login, id: m.id })),
        { login: repo.owner, fallback: true },
      ],
    }
  })
}

export type DownloadGroupsDisabledReason = "loading" | "unavailable" | "empty"

// Why the Download groups item is disabled, or undefined when it may run. The
// export joins against roster.csv, so an early click would flag every member
// unrostered or blank every team's repo; a failed read must not pass as an
// empty roster or an empty assignment.
export function downloadGroupsDisabledReason(input: {
  loading: boolean
  unavailable: boolean
  sourceCount: number
}): DownloadGroupsDisabledReason | undefined {
  if (input.loading) return "loading"
  if (input.unavailable) return "unavailable"
  if (input.sourceCount === 0) return "empty"
  return undefined
}

export function buildGroupMembershipCsvRows(
  groups: readonly GroupMembershipSource[],
  students: readonly Student[],
): GroupMembershipCsvRow[] {
  // Resolve by github_id first so a student who renamed their GitHub account
  // still joins to their roster row; the login is the fallback for roster
  // rows without an id. resolveGitHubId mirrors the Go reader (leading zeros
  // tolerated, anything else unresolved) so both surfaces join the same rows.
  const byId = new Map<number, Student>()
  const byLogin = new Map<string, Student>()
  for (const student of students) {
    const id = resolveGitHubId(student.github_id)
    if (id !== null && !byId.has(id)) byId.set(id, student)
    const login = student.username.trim().toLowerCase()
    if (login && !byLogin.has(login)) byLogin.set(login, student)
  }
  const resolve = (m: GroupMember): Student | undefined =>
    (m.id !== undefined ? byId.get(m.id) : undefined) ??
    byLogin.get(m.login.trim().toLowerCase())

  // Every free-text cell can carry student-influenced content (a login, a
  // team display name, roster names), so neutralize spreadsheet formulas on
  // all of them; `in_roster` and `note` are our own enum values.
  const esc = escapeCsvFormulaInjection
  const groupBlock = (g: GroupMembershipSource) => ({
    group: esc(g.group),
    group_name: esc(g.name ?? ""),
    team_slug: esc(g.teamSlug ?? ""),
    repo: esc(g.repoName ?? ""),
  })
  const emptyMember = {
    username: "",
    first_name: "",
    last_name: "",
    email: "",
    section: "",
    github_id: "",
    role: "",
    in_roster: "",
  }

  const rows: GroupMembershipCsvRow[] = []
  const ordered = [...groups].toSorted((a, b) =>
    naturalCompare(a.group, b.group),
  )
  for (const g of ordered) {
    if (g.members === undefined) {
      rows.push({
        ...groupBlock(g),
        ...emptyMember,
        note: GROUP_MEMBERSHIP_NOTE_UNREADABLE,
      })
      continue
    }
    // Dedupe on the resolved identity (a legacy founder is also a collaborator,
    // possibly under a renamed login). An unrostered member's username is the
    // lowercased live login so both surfaces spell it the same way.
    const seen = new Set<string>()
    const members: { student: Student; known: boolean }[] = []
    const live = g.members.filter((m) => !m.fallback)
    for (const raw of g.members) {
      const login = raw.login.trim()
      if (!login) continue
      const student = resolve(raw)
      if (raw.fallback && student === undefined && live.length > 0) continue
      const key = (student?.username ?? login).trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      members.push({
        student: student ?? placeholderStudent(login.toLowerCase()),
        known: student !== undefined,
      })
    }
    if (members.length === 0) {
      rows.push({ ...groupBlock(g), ...emptyMember, note: "" })
      continue
    }
    members.sort((a, b) => {
      const byKey = naturalCompare(
        studentSortKeyByLastName(a.student),
        studentSortKeyByLastName(b.student),
      )
      return byKey !== 0
        ? byKey
        : naturalCompare(a.student.username, b.student.username)
    })
    for (const { student, known } of members) {
      const id = resolveGitHubId(student.github_id)
      rows.push({
        ...groupBlock(g),
        username: esc(student.username.trim()),
        first_name: esc(student.first_name.trim()),
        last_name: esc(student.last_name.trim()),
        email: esc(student.email.trim()),
        section: esc(student.section.trim()),
        // Canonical digits or blank, never the raw cell: a hand-edited roster
        // could carry a formula-shaped value, and the CLI writes the parsed id.
        github_id: id === null ? "" : String(id),
        role: esc(student.role.trim()),
        in_roster: known ? "yes" : "no",
        note: "",
      })
    }
  }
  return rows
}
