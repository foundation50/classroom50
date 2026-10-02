import type { Student } from "@/types/classroom"
import { escapeCsvFormulaInjection } from "@/util/csv"
import { compareStudentsByName, placeholderStudent } from "@/util/students"

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

// A live member. `id` is the GitHub account id when the read carried one (a
// team or collaborator listing); a legacy founder derived from the repo name
// has only a login.
export type GroupMember = { login: string; id?: number }

export type GroupMembershipSource = {
  // The scores.json owner key: `group-<n>` (team) or the founder login (legacy).
  group: string
  name?: string
  teamSlug?: string
  repoName?: string
  // undefined when the live read failed, [] for a group with no members yet.
  members: readonly GroupMember[] | undefined
}

export function buildGroupMembershipCsvRows(
  groups: readonly GroupMembershipSource[],
  students: readonly Student[],
): GroupMembershipCsvRow[] {
  // Resolve by github_id first so a student who renamed their GitHub account
  // still joins to their roster row; the login is the fallback for roster
  // rows without an id.
  const byId = new Map<string, Student>()
  const byLogin = new Map<string, Student>()
  for (const student of students) {
    const id = student.github_id.trim()
    if (id && !byId.has(id)) byId.set(id, student)
    const login = student.username.trim().toLowerCase()
    if (login && !byLogin.has(login)) byLogin.set(login, student)
  }
  const resolve = (m: GroupMember): Student | undefined =>
    (m.id !== undefined ? byId.get(String(m.id)) : undefined) ??
    byLogin.get(m.login.trim().toLowerCase())
  const byName = compareStudentsByName("last")

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
  // Groups in a stable order: team counters numerically, founder logins
  // alphabetically (a natural compare handles both).
  const ordered = [...groups].toSorted((a, b) =>
    a.group.localeCompare(b.group, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
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
    if (g.members.length === 0) {
      rows.push({ ...groupBlock(g), ...emptyMember, note: "" })
      continue
    }
    // Dedupe on the resolved identity (a legacy founder is also a collaborator,
    // possibly under a renamed login) and order members like every other
    // roster view.
    const seen = new Set<string>()
    const members: { login: string; student: Student; known: boolean }[] = []
    for (const raw of g.members) {
      const login = raw.login.trim()
      if (!login) continue
      const student = resolve(raw)
      const key = (student?.username ?? login).trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      members.push({
        login,
        student: student ?? placeholderStudent(login),
        known: student !== undefined,
      })
    }
    members.sort((a, b) => byName(a.student, b.student))
    for (const { login, student, known } of members) {
      rows.push({
        ...groupBlock(g),
        // The roster's spelling of the login when known, else the live one.
        username: esc(known ? student.username.trim() : login),
        first_name: esc(student.first_name.trim()),
        last_name: esc(student.last_name.trim()),
        email: esc(student.email.trim()),
        section: esc(student.section.trim()),
        // github_id is numeric or blank, never formula-shaped; keep byte-exact.
        github_id: student.github_id.trim(),
        role: esc(student.role.trim()),
        in_roster: known ? "yes" : "no",
        note: "",
      })
    }
  }
  return rows
}
