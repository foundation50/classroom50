import type { Student } from "@/types/classroom"
import { escapeCsvFormulaInjection } from "@/util/csv"
import { compareStudentsByName, placeholderStudent } from "@/util/students"

// The group-membership export ("Download groups (CSV)"): one row per member of
// every group of a group/team assignment, joined against the roster so the
// file matches an LMS group roster without renaming. Column order is the
// cross-tool contract mirrored by the CLI (`gh teacher group list --csv`,
// contract.GroupMembershipCSVColumns): the group block is keyed like a
// scores.json group entry (`group` == its `owner`) so this file joins to the
// scores export, and the member block is exactly roster.csv's header. Keep
// both mirrors in lockstep.
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

// Mirrors contract.GroupMembershipNoteUnreadable: an unreadable group must not
// export as an empty one.
export const GROUP_MEMBERSHIP_NOTE_UNREADABLE = "membership could not be read"

// One group as the page already knows it, mode-neutral. Team mode fills every
// field; a legacy group leaves `name` and `teamSlug` undefined. `members` is
// undefined when the live read failed (as opposed to [] for a group with no
// members yet), which is what the `note` column reports.
export type GroupMembershipSource = {
  // The scores.json owner key: `group-<n>` (team) or the founder login (legacy).
  group: string
  name?: string
  teamSlug?: string
  // Blank for a team whose repo hasn't been created yet.
  repoName?: string
  members: readonly string[] | undefined
}

export function buildGroupMembershipCsvRows(
  groups: readonly GroupMembershipSource[],
  students: readonly Student[],
): GroupMembershipCsvRow[] {
  const byLogin = new Map<string, Student>()
  for (const student of students) {
    const login = student.username.trim().toLowerCase()
    if (login && !byLogin.has(login)) byLogin.set(login, student)
  }
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
    // Dedupe case-insensitively (a legacy founder is also a collaborator) and
    // order members like every other roster view.
    const seen = new Set<string>()
    const members: { login: string; student: Student; known: boolean }[] = []
    for (const raw of g.members) {
      const login = raw.trim()
      const key = login.toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const student = byLogin.get(key)
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
