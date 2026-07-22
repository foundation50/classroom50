// Pure derivation/filter/sort primitives for the assignment overview dashboard,
// over already-loaded scores/roster data — no fetches, no React, so the
// classification is reusable and testable.

import type { SubmissionRow } from "@/hooks/useGetScores"
import type { GitHubRepo } from "@/github-core/types"
import type { Student } from "@/types/classroom"
import type { BadgeTone } from "@/components/ui"
import { getName, nameFromParts } from "@/util/students"
import { studentRepoName } from "@/util/studentRepo"

// Whether a row's grade still belongs to a current roster member. A row is
// credited to `usernames` (group members, else [owner]); keep it when ANY
// credited login is on the roster, so a group with at least one current member
// still shows. Used to drop the grades of a since-unenrolled student: the CLI
// collector writes scores.json and never prunes on unenroll, so the web app —
// a pure consumer — filters the read against the live team roster rather than
// mutating the file (grades stay intact on disk for history / re-enrollment).
export function rowOnRoster(
  row: SubmissionRow,
  rosterLogins: Set<string>,
): boolean {
  return row.usernames.some((u) => rosterLogins.has(u.trim().toLowerCase()))
}

// Drop submission rows whose credited students are all off the current roster.
// Single choke point so every downstream consumer (table, stats, average, late
// count, CSV export) sees the same roster-scoped set.
export function rosterScopedRows(
  rows: SubmissionRow[],
  students: Student[],
): SubmissionRow[] {
  const rosterLogins = new Set(
    students
      .map((s) => s.username.trim().toLowerCase())
      .filter((u) => u.length > 0),
  )
  return rows.filter((row) => rowOnRoster(row, rosterLogins))
}

// Fold live submission presence (submit/* releases read directly from student
// repos) into the collected snapshot rows. `scores.json` stays the source of
// record for GRADES: a snapshot row keeps its graded score, history, and
// review link. Live data contributes two things on top:
//
//   - COUNT: a snapshot row's `submissionCount` is raised to the live count
//     when the student has pushed more submit/* releases than the last collect
//     ingested (the #347 lag). The row is flagged `staleCount` so the table can
//     hint that the newest push isn't graded yet. Live never LOWERS a count
//     (a live read is one page / a lower bound; the snapshot may legitimately
//     hold more), so the merged count is max(snapshot, live).
//   - PRESENCE: live adds a row ONLY for an owner absent from the snapshot — a
//     student who pushed but hasn't been collected yet. Such a row is `pending`
//     (no grade) with the live count, so the table shows "submitted, not yet
//     collected" rather than a fake 0/0.
//
// Owner match is case-insensitive; the union preserves snapshot order (with
// counts updated in place), then appends live-only rows newest-first.
export type LiveSubmissionPresence = {
  owner: string
  datetime: string
  release: string
  // Live submit/* release count for the repo (a lower bound; see LiveSubmission).
  submissionCount: number
}

export function mergeLiveRows(
  snapshotRows: SubmissionRow[],
  liveRows: LiveSubmissionPresence[],
): SubmissionRow[] {
  const liveByOwner = new Map<string, LiveSubmissionPresence>()
  for (const live of liveRows) {
    liveByOwner.set(live.owner.trim().toLowerCase(), live)
  }

  const merged = snapshotRows.map((row) => {
    const live = liveByOwner.get(row.owner.trim().toLowerCase())
    // Live is a lower bound (one page), so it can only reveal MORE submissions
    // than the snapshot captured, never fewer. Only bump + flag when it does,
    // and carry the live push time so the table can show the true latest push
    // (later than the graded datetime) without moving the graded submission.
    if (!live || live.submissionCount <= row.submissionCount) return row
    return {
      ...row,
      submissionCount: live.submissionCount,
      staleCount: true,
      liveLatestAt: live.datetime,
    }
  })

  const snapshotOwners = new Set(
    snapshotRows.map((row) => row.owner.trim().toLowerCase()),
  )

  const liveOnly = liveRows
    .filter((live) => !snapshotOwners.has(live.owner.trim().toLowerCase()))
    .sort(
      (a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime(),
    )
    .map<SubmissionRow>((live) => ({
      usernames: [live.owner],
      owner: live.owner,
      datetime: live.datetime,
      commit: "",
      release: live.release,
      review: "",
      score: 0,
      "max-score": 0,
      // At least 1 (the release we just saw); use the live count when higher.
      submissionCount: Math.max(1, live.submissionCount),
      pending: true,
      submissions: [],
    }))

  return [...merged, ...liveOnly]
}

// the assignment sets no threshold — then every row is "ungraded" (as is an
// ungraded/zero-max row).
export type PassState = "passing" | "failing" | "ungraded"

export function rowPassState(
  row: {
    score: number
    "max-score": number
  },
  thresholdFraction: number | null,
): PassState {
  if (thresholdFraction == null) return "ungraded"
  const max = row["max-score"]
  if (!max || !Number.isFinite(max)) return "ungraded"
  if (!Number.isFinite(row.score)) return "ungraded"
  return row.score / max >= thresholdFraction ? "passing" : "failing"
}

// Badge appearance for a score chip. The ungraded state (no threshold or
// zero/NaN max) has no semantic tone — it renders as daisyUI's neutral `ghost`
// badge, which `BadgeTone` can't express (ghost is a separate `<Badge ghost>`
// prop). So return a discriminated result the caller maps: `{ ghost: true }`
// -> `<Badge ghost>`, else `{ tone }`. Single source for the table row, the
// history timeline, and any future score chip.
export type ScoreTone = { ghost: true } | { ghost?: false; tone: BadgeTone }

export function scoreTone(
  score: number,
  max: number,
  thresholdFraction: number | null,
): ScoreTone {
  const state = rowPassState({ score, "max-score": max }, thresholdFraction)
  if (state === "ungraded") return { ghost: true }
  return { tone: state === "passing" ? "success" : "error" }
}

// Top-line stat-strip counts. `rostered` is meaningless as a group-assignment
// denominator (hidden there); `ungraded` is separate so it inflates neither
// passing nor failing.
export type SubmissionStats = {
  submitted: number
  rostered: number
  passing: number
  failing: number
  ungraded: number
  late: number
}

export function computeStats(
  rows: SubmissionRow[],
  rosteredCount: number,
  thresholdFraction: number | null,
): SubmissionStats {
  let passing = 0
  let failing = 0
  let ungraded = 0
  let late = 0
  for (const row of rows) {
    switch (rowPassState(row, thresholdFraction)) {
      case "passing":
        passing++
        break
      case "failing":
        failing++
        break
      default:
        ungraded++
    }
    if (row.late) late++
  }
  return {
    submitted: rows.length,
    rostered: rosteredCount,
    passing,
    failing,
    ungraded,
    late,
  }
}

// Mean of the numeric scores, rounded to 2 decimals, or null when none is finite
// (rendered "N/A"). Avoids the old `sum/length || 1` bug where an empty/NaN
// result showed "1" (`/` binds before `||`). Pending live rows (a submit/*
// release the collector hasn't ingested yet) carry a placeholder 0/0 and no
// real grade, so they're excluded — otherwise every uncollected submitter would
// drag the average toward 0, the opposite of the intended presence signal.
export function classAverage(rows: SubmissionRow[]): number | null {
  const numericScores = rows
    .filter((row) => !row.pending)
    .map((row) => Number(row["score"]))
    .filter((n) => Number.isFinite(n))
  if (numericScores.length === 0) return null
  const avg =
    numericScores.reduce((sum, n) => sum + n, 0) / numericScores.length
  return Math.round(avg * 100) / 100
}

// Filters the dashboard exposes. Each is independent ("all" = no constraint);
// combined filters AND together. `section` is "all" or an exact roster value.
export type SubmissionFilters = {
  submission: "all" | "submitted" | "on-time" | "late" | "not-submitted"
  passing: "all" | "passing" | "failing"
  accepted: "all" | "accepted" | "not-accepted"
  section: string
}

export const DEFAULT_FILTERS: SubmissionFilters = {
  submission: "all",
  passing: "all",
  accepted: "all",
  section: "all",
}

// Distinct, non-empty section values present on the roster, sorted for a
// stable dropdown. Empty when no student has a section.
export function distinctSections(students: Student[]): string[] {
  const sections = new Set<string>()
  for (const student of students) {
    const section = student.section?.trim()
    if (section) sections.add(section)
  }
  return [...sections].sort((a, b) => a.localeCompare(b))
}

// username (lowercased) -> section, for rows that carry only logins. Students
// with no section are omitted, so a lookup miss means "no section".
export function buildSectionLookup(students: Student[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const student of students) {
    const section = student.section?.trim()
    if (section) map.set(student.username.trim().toLowerCase(), section)
  }
  return map
}

// Whether a row (any credited username) belongs to the given section.
export function rowInSection(
  row: SubmissionRow,
  section: string,
  sectionByUsername: Map<string, string>,
): boolean {
  return row.usernames.some(
    (username) =>
      sectionByUsername.get(username.trim().toLowerCase()) === section,
  )
}

// Whether a roster student belongs to the given (non-"all") section.
export function studentInSection(student: Student, section: string): boolean {
  return (student.section?.trim() ?? "") === section
}

export type SubmissionSort = "recent" | "oldest" | "name-asc" | "name-desc"

// Who has accepted an INDIVIDUAL assignment, derived from the org repo list: a
// student accepted iff `<classroom>-<assignment>-<username>` exists. Independent
// of submission — a repo can exist without a graded push.
//
// Forward-construct each student's expected repo name rather than reverse-parsing
// a `<classroom>-<assignment>-` prefix: prefix-stripping over-matches a sibling
// whose slug extends this one (assignment "hw" would capture `cs-hw-bonus-alice`
// from "hw-bonus"), polluting the set and risking a 404 when the modal rebuilds
// a URL. (existingGroupRepos below must reverse-parse and so guards this
// explicitly against the sibling assignment list.)
//
// Group assignments are excluded (repo named after the owner, not each member),
// so callers offer the accepted filter for individual assignments only.
export function acceptedUsernames(
  repos: GitHubRepo[] | null | undefined,
  classroom: string,
  assignment: string,
  students: Student[],
): Set<string> {
  const accepted = new Set<string>()
  if (!repos) return accepted
  // studentRepoName lowercases; match the repo list against it.
  const repoNames = new Set(repos.map((repo) => repo.name.toLowerCase()))
  for (const student of students) {
    const username = student.username.trim()
    if (!username) continue
    if (repoNames.has(studentRepoName(classroom, assignment, username))) {
      accepted.add(username.toLowerCase())
    }
  }
  return accepted
}

// Whether a student (by username) has accepted, given the derived set.
export function hasAccepted(username: string, accepted: Set<string>): boolean {
  return accepted.has(username.trim().toLowerCase())
}

// An existing group repo derived from the org repo list, keyed by its founder
// (the `<owner>` segment of `<classroom>-<assignment>-<owner>`).
export type GroupRepo = { owner: string; repoName: string }

// Group repos that exist for the assignment. Unlike individual acceptance, the
// founder logins aren't known up front (group repos are named after whoever
// created the group), so we must reverse-parse the `<classroom>-<assignment>-`
// prefix rather than forward-construct per student. Prefix-stripping alone
// over-matches a sibling whose slug extends this one (assignment "hw1" capturing
// `cs101-hw1-bonus-alice` from "hw1-bonus"), so reject any repo that belongs to
// a longer sibling assignment: `siblingSlugs` is the classroom's other slugs, and
// a repo under `<classroom>-<sibling>-` where `<sibling>` extends `<assignment>-`
// is that sibling's, not ours. Empty owner segments (a bare
// `<classroom>-<assignment>-`) are rejected.
export function existingGroupRepos(
  repos: GitHubRepo[] | null | undefined,
  classroom: string,
  assignment: string,
  siblingSlugs: string[] = [],
): GroupRepo[] {
  if (!repos) return []
  const prefix = `${classroom}-${assignment}-`.toLowerCase()
  // Prefixes of sibling assignments whose slug strictly extends this one; a repo
  // under any of these was created for the sibling, not this assignment.
  const overlapPrefixes = siblingSlugs
    .map((slug) => slug.toLowerCase())
    .filter((slug) => slug !== assignment.toLowerCase())
    .map((slug) => `${classroom}-${slug}-`.toLowerCase())
    .filter((siblingPrefix) => siblingPrefix.startsWith(prefix))
  const out: GroupRepo[] = []
  for (const repo of repos) {
    const name = repo.name.toLowerCase()
    if (!name.startsWith(prefix)) continue
    if (overlapPrefixes.some((sibling) => name.startsWith(sibling))) continue
    const owner = name.slice(prefix.length)
    if (!owner) continue
    out.push({ owner, repoName: name })
  }
  return out
}

// Roster students with no submission, with group-repo members excluded (#245).
// "Credited" = login appears in any score row's `usernames` (member_usernames
// for groups, else [owner]). A login in `groupRepoMembers` (an existing group
// repo's founder or a fetched collaborator) is also excluded — they already
// appear as that group's repo row, so listing them as "no group" too would
// double-count them. Pure derivation extracted from SubmissionsPage so the
// reconciliation is unit-testable.
export function reconcileNonSubmitters(
  students: Student[],
  scoreRows: { usernames: string[] }[],
  groupRepoMembers: Set<string>,
): Student[] {
  const credited = new Set(
    scoreRows.flatMap((row) => row.usernames.map((u) => u.toLowerCase())),
  )
  return students.filter((student) => {
    const login = student.username.toLowerCase()
    return !credited.has(login) && !groupRepoMembers.has(login)
  })
}

// Per-row status for a roster student with no submission row. Distinguishes the
// three states that would otherwise collapse into a flat "Not submitted":
//   - no-group: group assignment — the student isn't credited on any submitting
//     group's repo (group repos are named after the founder, so a never-joined
//     student has nothing to reconcile against).
//   - accepted-not-submitted: individual — a repo exists (accepted) but no push.
//   - not-accepted: individual — never accepted, so no repo.
//   - not-submitted: acceptance data unavailable (repos not loaded yet) — a
//     neutral fallback so a transient empty repo list can't mislabel everyone.
export type NonSubmitterStatus =
  "no-group" | "accepted-not-submitted" | "not-accepted" | "not-submitted"

export function nonSubmitterStatus(
  username: string,
  {
    isGroup,
    acceptedUsernames,
  }: { isGroup: boolean; acceptedUsernames?: Set<string> },
): NonSubmitterStatus {
  if (isGroup) return "no-group"
  if (!acceptedUsernames) return "not-submitted"
  return hasAccepted(username, acceptedUsernames)
    ? "accepted-not-submitted"
    : "not-accepted"
}

// The combined "Status" toolbar select folds the submission axis and the
// acceptance axis into one control. Its option ids are a closed literal union
// (no `${axis}:${value}` string encoding, no `as` casts) so a renamed filter
// value fails at compile time instead of silently mismatching at runtime.
export type StatusSelectValue =
  | "all"
  | "submitted"
  | "on-time"
  | "late"
  | "not-submitted"
  | "accepted"
  | "not-accepted"

// Which combined value the current filters map to. Submission takes precedence
// (a submitted row is accepted by definition), then acceptance, else "all".
export function statusSelectValue(
  filters: SubmissionFilters,
): StatusSelectValue {
  if (filters.submission !== "all") return filters.submission
  if (filters.accepted !== "all") return filters.accepted
  return "all"
}

// Apply a combined-select choice, resetting the other axis so the two stay
// mutually exclusive from this control. Submission values set `submission`
// (accepted reset to "all"); acceptance values set `accepted` (submission reset
// to "all").
export function applyStatusSelection(
  filters: SubmissionFilters,
  value: StatusSelectValue,
): SubmissionFilters {
  switch (value) {
    case "all":
      return { ...filters, submission: "all", accepted: "all" }
    case "accepted":
    case "not-accepted":
      return { ...filters, accepted: value, submission: "all" }
    default:
      return { ...filters, submission: value, accepted: "all" }
  }
}

// Count of ROSTER students who accepted. Intersecting with the roster keeps the
// "Accepted N / roster" stat from exceeding its denominator when `accepted`
// includes non-roster owners (an unenrolled student, a stray test repo).
export function acceptedRosterCount(
  students: Student[],
  accepted: Set<string>,
): number {
  return students.filter((student) => hasAccepted(student.username, accepted))
    .length
}

// Case-insensitive match of a query against a row's identities: each credited
// username plus its roster display name (so searching a real name works though
// scores.json only carries logins).
export function rowMatchesQuery(
  row: SubmissionRow,
  query: string,
  students: Student[],
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return row.usernames.some((username) => {
    if (username.toLowerCase().includes(q)) return true
    const name = getName(username, students)
    return Boolean(name) && name.toLowerCase().includes(q)
  })
}

// Search + filters + sort over the submitted rows. "not-submitted" lives in the
// caller's nonSubmitters list, so that filter hides every submitted row;
// likewise "not-accepted", since a submitted row always has a repo.
export function filterAndSortRows(
  rows: SubmissionRow[],
  {
    query,
    filters,
    sort,
    students,
    sectionByUsername,
    thresholdFraction,
  }: {
    query: string
    filters: SubmissionFilters
    sort: SubmissionSort
    students: Student[]
    sectionByUsername: Map<string, string>
    thresholdFraction: number | null
  },
): SubmissionRow[] {
  const filtered = rows.filter((row) => {
    if (!rowMatchesQuery(row, query, students)) return false

    // A submitted row always has a repo, so it's accepted by definition.
    if (filters.accepted === "not-accepted") return false

    if (
      filters.section !== "all" &&
      !rowInSection(row, filters.section, sectionByUsername)
    ) {
      return false
    }

    switch (filters.submission) {
      case "not-submitted":
        return false
      case "late":
        if (!row.late) return false
        break
      case "on-time":
        if (row.late) return false
        break
    }

    if (filters.passing !== "all") {
      const state = rowPassState(row, thresholdFraction)
      if (state !== filters.passing) return false
    }

    return true
  })

  const byName = (row: SubmissionRow) =>
    (
      getName(row.usernames[0], students) ||
      row.usernames[0] ||
      ""
    ).toLowerCase()

  // Key each row's name + time once before sorting: byName scans the roster
  // linearly, so calling it in the comparator would repeat it O(rows·log rows).
  const keyed = filtered.map((row) => ({
    row,
    name: byName(row),
    time: new Date(row.datetime).getTime(),
  }))

  keyed.sort((a, b) => {
    switch (sort) {
      case "oldest":
        return a.time - b.time
      case "name-asc":
        return a.name.localeCompare(b.name)
      case "name-desc":
        return b.name.localeCompare(a.name)
      case "recent":
      default:
        return b.time - a.time
    }
  })

  return keyed.map((k) => k.row)
}

// Whether non-submitters should still appear under the current filters. Any
// submission/passing constraint implies a submission exists, hiding them; the
// accepted filter does not (both accepted-not-submitted and not-accepted are
// non-submitter states).
export function showsNonSubmitters(filters: SubmissionFilters): boolean {
  if (filters.passing !== "all") return false
  return filters.submission === "all" || filters.submission === "not-submitted"
}

// Filters non-submitters by search query and the accepted filter. `accepted` is
// the set from acceptedUsernames (empty for group assignments, where the UI
// disables the accepted filter).
export function filterNonSubmitters(
  nonSubmitters: Student[],
  query: string,
  filters: SubmissionFilters,
  accepted: Set<string>,
): Student[] {
  const q = query.trim().toLowerCase()
  return nonSubmitters.filter((student) => {
    if (q) {
      const name = `${student.first_name} ${student.last_name}`
        .trim()
        .toLowerCase()
      if (
        !student.username.toLowerCase().includes(q) &&
        !(Boolean(name) && name.includes(q))
      ) {
        return false
      }
    }

    if (
      filters.section !== "all" &&
      !studentInSection(student, filters.section)
    ) {
      return false
    }

    if (filters.accepted !== "all") {
      const didAccept = hasAccepted(student.username, accepted)
      if (filters.accepted === "accepted" && !didAccept) return false
      if (filters.accepted === "not-accepted" && didAccept) return false
    }

    return true
  })
}

// Rows for the exported gradebook CSV, in the order the file writes them.
// Submitters come first (newest submission first), then non-submitters pinned
// after with a 0 score and blank submission fields, so the export covers the
// whole roster. Column order and the empty-string-vs-literal typing are the
// contract downstream sheets rely on — keep them stable.
export type ScoresCsvRow = {
  usernames: string
  score: number | string
  max_score: number | string
  submissions: number
  submitted_at: string
  late: string
  commit: string
  review: string
  release: string
}

export function buildScoresCsvRows(
  scoresInfo: SubmissionRow[],
  nonSubmitters: Student[],
): ScoresCsvRow[] {
  const submittedRows: ScoresCsvRow[] = scoresInfo
    .toSorted(
      (a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime(),
    )
    .map(({ usernames, score, datetime, submissionCount, late, ...rest }) => ({
      usernames: usernames.join(", "),
      // A pending live row (submitted, not yet collected) has no real grade —
      // export a blank score, not a 0, so importing the CSV can't record a
      // graded zero for a student who actually submitted.
      score: rest.pending ? "" : score,
      max_score: rest.pending ? "" : rest["max-score"],
      submissions: submissionCount,
      submitted_at: new Date(datetime).toISOString(),
      late: late ? "yes" : "no",
      commit: rest.commit,
      review: rest.review,
      release: rest.release,
    }))

  const nonSubmittedRows: ScoresCsvRow[] = nonSubmitters.map((student) => ({
    usernames: student.username,
    score: 0,
    max_score: "",
    submissions: 0,
    submitted_at: "",
    late: "",
    commit: "",
    review: "",
    release: "",
  }))

  return [...submittedRows, ...nonSubmittedRows]
}

// Which workflow action a single contextual "View …" link points at, and which
// status strip (if any) shows. A running action wins; else the most recently
// finished; else null. Derived fresh each render so the link never sticks on a
// stale action. `idle` phases mean "nothing to show" for that action.
export type WorkflowPhaseState = { running: boolean; idle: boolean }

export function selectActiveWorkflowAction(
  collect: WorkflowPhaseState,
  regrade: WorkflowPhaseState,
): "collect" | "regrade" | null {
  if (collect.running) return "collect"
  if (regrade.running) return "regrade"
  if (!collect.idle) return "collect"
  if (!regrade.idle) return "regrade"
  return null
}

// Client-side table pagination over the combined display list. For an
// INDIVIDUAL assignment the list is one row per roster student in name order
// (the roster is pre-sorted by sortStudentsByName): a student with a submission
// renders as a "row", otherwise as a "nonSubmitter" — submitters and
// non-submitters interleave by name rather than grouping. For a GROUP
// assignment the unit is the repo, not the student, so submitted group rows
// come first (name-ordered) then unsubmitted group repos. Pagination spans the
// whole list as one sequence, and the current page's owners drive the live
// fan-out (so it reads only the repos on the page you're viewing).
export type DisplayItem =
  | { kind: "row"; row: SubmissionRow }
  | { kind: "nonSubmitter"; student: Student }
  | { kind: "groupRepo"; repo: GroupRepo }

// The default and offered "Show N entries" page sizes (mirrors the reference
// gradebook UI). Default is the first entry.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
export const DEFAULT_PAGE_SIZE: number = PAGE_SIZE_OPTIONS[0]

// Build the ordered display list for an INDIVIDUAL assignment: one item per
// roster student, in the roster's (name-sorted) order, each resolved to the
// student's submission row when one exists (owner match, case-insensitive) or a
// non-submitter item otherwise. `rows` are the already filtered/sorted submitted
// rows; `nonSubmitters` the already filtered non-submitter students. A student
// present in neither filtered set (filtered out) is omitted. Interleaving by
// the roster spine — rather than concatenating the two groups — is what makes a
// page a clean deterministic slice of the roster.
export function buildRosterDisplayItems(
  roster: Student[],
  rows: SubmissionRow[],
  nonSubmitters: Student[],
): DisplayItem[] {
  const rowByOwner = new Map<string, SubmissionRow>()
  for (const row of rows) rowByOwner.set(row.owner.trim().toLowerCase(), row)
  const nonSubmitterLogins = new Set(
    nonSubmitters.map((s) => s.username.trim().toLowerCase()),
  )

  const items: DisplayItem[] = []
  const seen = new Set<string>()
  for (const student of roster) {
    const login = student.username.trim().toLowerCase()
    seen.add(login)
    const row = rowByOwner.get(login)
    if (row) {
      items.push({ kind: "row", row })
    } else if (nonSubmitterLogins.has(login)) {
      items.push({ kind: "nonSubmitter", student })
    }
    // A student in neither filtered set was filtered out — omit.
  }
  // A submitted row whose owner isn't on the roster (an unenrolled student still
  // in scores.json, a group founder, a stray repo) won't appear via the roster
  // walk. rosterScopedRows already drops off-roster rows for individual
  // assignments, so this is defensive: append any leftover rows in their given
  // order so a real submission is never hidden.
  for (const row of rows) {
    if (!seen.has(row.owner.trim().toLowerCase())) {
      items.push({ kind: "row", row })
    }
  }
  return items
}

// Build the display list for a GROUP assignment in the name-ordered live view:
// one item per group founder, name-sorted, resolved to the founder's submitted
// row when one exists (owner match) else an unsubmitted group-repo row. This is
// the group analog of buildRosterDisplayItems and pages in the SAME order as
// pageRepoOwnerSpine's group branch, so the live fan-out and the rendered page
// line up. `rows` are the (filtered) submitted group rows; `groupRepos` the
// unsubmitted group repos.
export function buildGroupRosterDisplayItems(
  rows: SubmissionRow[],
  groupRepos: GroupRepo[],
  students: Student[],
): DisplayItem[] {
  const submitted = rows.map<DisplayItem>((row) => ({ kind: "row", row }))
  const unsubmitted = groupRepos.map<DisplayItem>((repo) => ({
    kind: "groupRepo",
    repo,
  }))
  // Precompute the name map once so the comparator is O(1) per compare (getName
  // would re-scan the roster each call). ownerSortKey matches pageRepoOwnerSpine's
  // group ordering, keeping the rendered page and the fan-out spine aligned.
  const names = buildNameKeyLookup(students)
  return [...submitted, ...unsubmitted].sort((a, b) =>
    ownerSortKey(displayItemOwner(a), names).localeCompare(
      ownerSortKey(displayItemOwner(b), names),
    ),
  )
}

// Build the ordered display list for a GROUP assignment under a non-name sort (a
// static snapshot view): submitted group rows first (in the caller's sort
// order), then unsubmitted group repos.
export function buildGroupDisplayItems(
  rows: SubmissionRow[],
  groupRepos: GroupRepo[],
): DisplayItem[] {
  return [
    ...rows.map<DisplayItem>((row) => ({ kind: "row", row })),
    ...groupRepos.map<DisplayItem>((repo) => ({ kind: "groupRepo", repo })),
  ]
}

// Build the display list for an INDIVIDUAL assignment under a non-name sort (a
// static snapshot view — live is off then, so there's no roster-spine coupling
// to preserve): the already-sorted submitted rows first, then non-submitters.
// Preserves the caller's chosen sort for the submitted rows rather than forcing
// the roster's name order.
export function buildSortedDisplayItems(
  rows: SubmissionRow[],
  nonSubmitters: Student[],
): DisplayItem[] {
  return [
    ...rows.map<DisplayItem>((row) => ({ kind: "row", row })),
    ...nonSubmitters.map<DisplayItem>((student) => ({
      kind: "nonSubmitter",
      student,
    })),
  ]
}

export type PageBounds = {
  // 0-based page clamped to [0, pageCount-1]; 0 when the list is empty.
  page: number
  pageCount: number
  // 1-based inclusive range of items shown, for the "N to M of T" label; both 0
  // when the list is empty.
  from: number
  to: number
  total: number
}

// Clamp a requested page to the valid range for a list of `total` items at
// `pageSize`. Pure so the page/label math is unit-testable and shared between
// the footer and the slice.
export function pageBounds(
  total: number,
  pageSize: number,
  requestedPage: number,
): PageBounds {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
  if (total === 0) {
    return { page: 0, pageCount, from: 0, to: 0, total: 0 }
  }
  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  return { page, pageCount, from, to, total }
}

// The slice of display items for the clamped current page.
export function paginateDisplayItems(
  items: DisplayItem[],
  pageSize: number,
  requestedPage: number,
): DisplayItem[] {
  const { page } = pageBounds(items.length, pageSize, requestedPage)
  const start = page * pageSize
  return items.slice(start, start + pageSize)
}

// The repo-owner login for a display item, so the live fan-out can read exactly
// the repos on the current page. Submitted/pending rows and group repos are
// keyed by `owner`; a non-submitter by its roster username. Empty string is
// filtered by the caller.
export function displayItemOwner(item: DisplayItem): string {
  switch (item.kind) {
    case "row":
      return item.row.owner
    case "nonSubmitter":
      return item.student.username
    case "groupRepo":
      return item.repo.owner
  }
}

// A `login (lowercased) -> display name (lowercased)` map for the roster, built
// once so the group name-ordering and search don't call getName (an O(n) roster
// scan) inside a comparator or filter — which turns an O(n log n) sort into
// O(n^2). The value mirrors getName exactly: the display name, or "" when the
// login isn't on the roster or the row has no name. Shared by the fan-out spine
// and the group display-item builder so their orderings can't drift.
export function buildNameKeyLookup(students: Student[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const student of students) {
    const login = student.username.trim().toLowerCase()
    if (!login) continue
    map.set(
      login,
      nameFromParts(student.first_name, student.last_name).toLowerCase(),
    )
  }
  return map
}

// A single owner's group SORT key from the precomputed name map: display name
// when the founder is on the roster with a name, else the login — lowercased.
// (Mirrors the prior `getName(owner) || owner`.)
function ownerSortKey(owner: string, names: Map<string, string>): string {
  return names.get(owner.trim().toLowerCase()) || owner.toLowerCase()
}

// An owner's display name for SEARCH matching (name only, "" when off-roster or
// nameless) — mirrors the prior `getName(owner).toLowerCase()`, so the login is
// matched separately by the caller, not folded in here.
function ownerSearchName(owner: string, names: Map<string, string>): string {
  return names.get(owner.trim().toLowerCase()) ?? ""
}

// The full, deterministic, name-ordered owner list the live fan-out pages over
// — filtered by search + section ONLY (NOT submitted/passing status). Those
// status axes depend on live presence, so using them here would make the owner
// set depend on the very data we're fetching; search/section are live-
// independent, so the spine is stable across the live merge and the fan-out
// doesn't loop. For groups the unit is the founder/repo owner. This is the
// single source both the fan-out slice (pageRepoOwners) and the page-count
// clamp read, so the fanned-out page can't drift from a page the user can see.
export function pageRepoOwnerSpine({
  isGroup,
  roster,
  groupRepos,
  query,
  section,
  sectionByUsername,
  students,
}: {
  isGroup: boolean
  roster: Student[]
  groupRepos: GroupRepo[]
  query: string
  section: string
  sectionByUsername: Map<string, string>
  students: Student[]
}): string[] {
  const q = query.trim().toLowerCase()
  const names = buildNameKeyLookup(students)
  if (isGroup) {
    // Page the group founders in the SAME order the table renders them: by
    // founder display name (the name-asc live view). Match search against the
    // founder login or roster display name. Section isn't a group concept.
    return [...groupRepos]
      .sort((a, b) =>
        ownerSortKey(a.owner, names).localeCompare(
          ownerSortKey(b.owner, names),
        ),
      )
      .filter((repo) => {
        if (!q) return true
        if (repo.owner.toLowerCase().includes(q)) return true
        const name = ownerSearchName(repo.owner, names)
        return name.length > 0 && name.includes(q)
      })
      .map((repo) => repo.owner)
  }
  return roster
    .filter((student) => {
      if (
        section !== "all" &&
        sectionByUsername.get(student.username.trim().toLowerCase()) !== section
      ) {
        return false
      }
      if (!q) return true
      const login = student.username.toLowerCase()
      if (login.includes(q)) return true
      const name = ownerSearchName(student.username, names)
      return name.length > 0 && name.includes(q)
    })
    .map((student) => student.username)
    .filter(Boolean)
}

// The repo owners the live fan-out should read for the current page — a
// page-scoped slice of pageRepoOwnerSpine so a large class is read a page at a
// time (each page's owner-set is cached by react-query), not all at once.
export function pageRepoOwners(args: {
  isGroup: boolean
  roster: Student[]
  groupRepos: GroupRepo[]
  query: string
  section: string
  sectionByUsername: Map<string, string>
  students: Student[]
  page: number
  pageSize: number
}): string[] {
  const owners = pageRepoOwnerSpine(args)
  const { page: clamped } = pageBounds(owners.length, args.pageSize, args.page)
  const start = clamped * args.pageSize
  return owners.slice(start, start + args.pageSize)
}

// The compact list of page numbers to render, with `null` marking an ellipsis
// gap. Always shows first/last, the current page, and one neighbor each side;
// collapses the rest. Keeps the nav to at most ~7 controls regardless of count.
export function paginationRange(
  page: number,
  pageCount: number,
): (number | null)[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i)
  }
  const pages = new Set<number>([0, pageCount - 1, page, page - 1, page + 1])
  const sorted = [...pages]
    .filter((p) => p >= 0 && p < pageCount)
    .sort((a, b) => a - b)
  const out: (number | null)[] = []
  let prev = -1
  for (const p of sorted) {
    if (prev >= 0 && p - prev > 1) out.push(null)
    out.push(p)
    prev = p
  }
  return out
}
