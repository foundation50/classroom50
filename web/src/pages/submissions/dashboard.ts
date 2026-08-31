// Pure derivation/filter/sort primitives for the assignment overview dashboard,
// over already-loaded scores/roster data — no fetches, no React, so the
// classification is reusable and testable.

import type { SubmissionRow } from "@/hooks/useGetScores"
import type { GitHubRepo } from "@/github-core/types"
import { latestDetectedAt } from "@/domain/assignments/submissionDetection"
import { existingAssignmentRepos } from "@/domain/assignments/assignmentRepoPresence"
import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import type { Student } from "@/types/classroom"
import type { BadgeTone } from "@/components/ui"
import type { TeamRosterRow } from "@/util/teamRoster"
import { rowToStudent } from "@/util/teamRoster"
import { hasStudentEnrollment } from "@/util/classroomRoleUI"
import {
  compareStudentsByName,
  getName,
  nameFromParts,
  NAME_COLLATION,
  placeholderStudent,
  resolveStudent,
  studentSortKeyFor,
  type StudentSortMode,
} from "@/util/students"
import {
  studentRepoName,
  parseGroupRepoCounter,
  GROUP_REPO_SEGMENT,
} from "@/util/studentRepo"
import { escapeCsvFormulaInjection } from "@/util/csv"

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

// The gradee roster spine for the submissions view. Always includes every
// enrolled STUDENT row (a plain student, or a student who is also staff) —
// unchanged behavior, so a student who never accepted still shows as "not
// accepted". A pure staff row (teacher/hta/ta with no student enrollment) is
// included ONLY when that staff member has ACCEPTED this assignment, so a staff
// member testing the autograde flow appears exactly like a student while staff
// who never accepted stay hidden.
//
// Acceptance is derived from what already exists, no per-user fetch: for an
// individual assignment, their `<classroom>-<assignment>-<login>` repo is in
// the org repo list (`acceptedStaffLogins`); for a group assignment, they're a
// founder or credited member of an existing group repo (`groupRepoMembers`,
// lowercased). Collection independently picks up the same accepted staff (it
// polls the staff teams and only records a repo that exists), so the view and
// the gradebook stay in step.
export function submissionRosterStudents(
  teamRows: TeamRosterRow[],
  {
    acceptedStaffLogins,
    groupRepoMembers,
  }: {
    acceptedStaffLogins: Set<string>
    groupRepoMembers: Set<string>
  },
): Student[] {
  const enrolled = teamRows.filter((r) => r.state === "enrolled")
  const out: Student[] = []
  for (const row of enrolled) {
    if (hasStudentEnrollment(row)) {
      out.push(rowToStudent(row))
      continue
    }
    const login = row.username.trim().toLowerCase()
    if (!login) continue
    if (acceptedStaffLogins.has(login) || groupRepoMembers.has(login)) {
      out.push(rowToStudent(row))
    }
  }
  return out
}

// Fold live submission presence (submit/* releases read directly from student
// repos) into the collected snapshot rows. `scores.json` stays the source of
// record for GRADES; live contributes only:
//
//   - COUNT: raise a row's `submissionCount` to the live count when the student
//     pushed more submit/* releases than the last collect ingested (the #347
//     lag), flagging `staleCount`. Live never LOWERS a count (a live read is one
//     page, a lower bound), so the merge is max(snapshot, live).
//   - PRESENCE: add a `pending` row (no grade) only for an owner absent from the
//     snapshot — pushed but not yet collected — so the table shows "submitted,
//     not yet collected" rather than a fake 0/0.
//
// Owner match is case-insensitive; snapshot order is preserved, then live-only
// rows appended newest-first.
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
  // The assignment's due date (ISO), used only to derive `late` for PENDING
  // live-only rows — collected rows keep the collector-computed `late`.
  dueDate?: string | null,
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
      // A teacher-overridden (manual) grade is frozen by hand and never
      // auto-collected, so the "re-collect" stale hint doesn't apply — bump the
      // count but don't flag it. Autograded rows still surface the stale hint.
      staleCount: !row.overridden,
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
      // The collector isn't here to compute `late` for this not-yet-collected
      // row, so derive it from the live submission time vs the due date —
      // otherwise a pending late submission reads as on-time until the next
      // collect. Left undefined (never guessed) without a parseable pair.
      late: liveLateness(live.datetime, dueDate),
      submissions: [],
    }))

  return [...merged, ...liveOnly]
}

// `late` for a pending live row: submission time strictly after the due date.
// Undefined (unknown, not "on time") when either side is missing/unparseable.
function liveLateness(
  submittedAt: string,
  dueDate: string | null | undefined,
): boolean | undefined {
  if (!dueDate) return undefined
  const submittedMs = new Date(submittedAt).getTime()
  const dueMs = new Date(dueDate).getTime()
  if (!Number.isFinite(submittedMs) || !Number.isFinite(dueMs)) return undefined
  return submittedMs > dueMs
}

// Detected-submission presence for one repo, from the detection subsystem
// (branch-mode default-branch commits or tag-mode git tags). Like the live
// overlay, this is count/presence only — grades never come from here (KTD6).
// `entries` is the per-submission breakdown (tags/commits) the expanded history
// surfaces as jump-to-tag links; omitted when the caller only needs the count.
export type DetectedPresence = {
  owner: string
  count: number
  entries?: DetectedSubmission[]
}

// Merge detected submissions onto rows already reconciled with the live
// overlay, the second overlay on the same snapshot (KTD6). Same discipline as
// mergeLiveRows: detection can only REVEAL more submissions than are already
// counted (max wins), never fewer, and never sets a score. A detection-only
// owner (commits/tags but no submit/* release and no snapshot entry) becomes a
// pending row so the teacher sees the work exists, ungraded — carrying the
// newest detected submission time (commit dates in branch mode; encoded
// submit/* timestamps or milestone commit lookups in tag mode) so the "last
// submitted" cell shows when the work landed instead of a bare "not yet
// collected".
export function mergeDetectedSubmissions(
  rows: SubmissionRow[],
  detected: DetectedPresence[],
  // The assignment's due date (ISO), used only to derive `late` for PENDING
  // detection-only rows — mirrors the mergeLiveRows parameter.
  dueDate?: string | null,
): SubmissionRow[] {
  const detectedByOwner = new Map<string, DetectedPresence>()
  for (const d of detected) {
    detectedByOwner.set(d.owner.trim().toLowerCase(), d)
  }

  const merged = rows.map((row) => {
    const d = detectedByOwner.get(row.owner.trim().toLowerCase())
    if (!d) return row
    // Attach the detected breakdown (tags/commits) regardless of the count —
    // the expanded history lists tagged submissions even when scores.json
    // already counts them. Detection can only REVEAL more submissions than are
    // already counted (max wins), never fewer, and never sets a score; only a
    // higher count bumps the total and flags staleCount.
    const withEntries =
      d.entries && d.entries.length > 0
        ? { ...row, detectedEntries: d.entries }
        : row
    if (d.count <= row.submissionCount) return withEntries
    // staleCount off for overrides — see mergeLiveRows.
    return {
      ...withEntries,
      submissionCount: d.count,
      staleCount: !row.overridden,
      // Surface the newest detected push on the live sub-line when it beats
      // both the row's recorded time and any release-based live latest, so a
      // stale-count row says WHEN the newer work landed, not just that it did.
      liveLatestAt:
        newerDetectedAt(d.entries, row.datetime, row.liveLatestAt) ??
        row.liveLatestAt,
    }
  })

  const knownOwners = new Set(rows.map((row) => row.owner.trim().toLowerCase()))

  const detectedOnly = detected
    .filter(
      (d) => d.count > 0 && !knownOwners.has(d.owner.trim().toLowerCase()),
    )
    .map<SubmissionRow>((d) => {
      const detectedAt = latestDetectedAt(d.entries) ?? ""
      return {
        usernames: [d.owner],
        owner: d.owner,
        datetime: detectedAt,
        commit: "",
        release: "",
        review: "",
        score: 0,
        "max-score": 0,
        submissionCount: Math.max(1, d.count),
        pending: true,
        // Derive `late` only from a trustworthy time. A commit's committer
        // date is server-recorded on push; a tag entry's time is decoded from
        // the student-authored `submit/<ts>` tag NAME, which a student can
        // backdate to read on-time. So only branch-mode commit entries feed
        // lateness here; a tag-mode pending row leaves `late` undefined until
        // the collector marks it from the authoritative release datetime.
        late: liveLateness(latestCommitDetectedAt(d.entries), dueDate),
        detectedEntries: d.entries,
        submissions: [],
      }
    })

  return [...merged, ...detectedOnly]
}

// The newest detected time when it's strictly newer than BOTH reference
// instants (the row's recorded submission and any already-set live latest);
// null otherwise, so an older/equal detection never displaces either.
function newerDetectedAt(
  entries: DetectedSubmission[] | undefined,
  rowDatetime: string,
  currentLiveLatestAt: string | undefined,
): string | null {
  const detectedAt = latestDetectedAt(entries)
  if (!detectedAt) return null
  const detectedMs = new Date(detectedAt).getTime()
  if (!Number.isFinite(detectedMs)) return null
  for (const reference of [rowDatetime, currentLiveLatestAt]) {
    if (!reference) continue
    const referenceMs = new Date(reference).getTime()
    if (Number.isFinite(referenceMs) && detectedMs <= referenceMs) return null
  }
  return detectedAt
}

// The newest time among branch-mode COMMIT detections only, or "" when none
// carry one. Used to derive `late` for a pending row: a commit's committer
// date is server-recorded on push, whereas a tag entry's time is decoded from
// the student-authored `submit/<ts>` tag name and can be backdated to dodge a
// late flag — so tag times must never feed lateness (the collector marks tag
// lateness later from the authoritative release datetime).
function latestCommitDetectedAt(
  entries: DetectedSubmission[] | undefined,
): string {
  return (
    latestDetectedAt((entries ?? []).filter((e) => e.kind === "commit")) ?? ""
  )
}

// The most recent push time across this assignment's repos, or null when none
// exist. A cheap staleness heuristic: a repo pushed AFTER the last collect run
// means scores.json is (probably) out of date.
//
// Reads the already-loaded org repo list (`pushed_at` from `GET
// /orgs/{org}/repos`), so it costs NO extra API call. Repo selection (prefix
// match, sibling-slug guard) is shared with existingAssignmentRepos so the two
// repo-list-derived signals can never disagree on which repos belong to an
// assignment. Returns the winning repo's ISO `pushed_at`.
export function latestAssignmentPush(
  repos: GitHubRepo[] | null | undefined,
  classroom: string,
  assignment: string,
  siblingSlugs: string[] = [],
): string | null {
  let latest: number | null = null
  let latestIso: string | null = null
  for (const repo of existingAssignmentRepos(
    repos,
    classroom,
    assignment,
    siblingSlugs,
  )) {
    const pushed = repo.pushed_at
    if (!pushed) continue
    const ms = new Date(pushed).getTime()
    if (!Number.isFinite(ms)) continue
    if (latest === null || ms > latest) {
      latest = ms
      latestIso = pushed
    }
  }
  return latestIso
}

// Whether the collected snapshot is (probably) stale: an assignment repo was
// pushed after the last completed collect run. Both inputs are ISO strings;
// null `lastCollectedAt` (never collected) with any push counts as stale, and a
// null `latestPush` (no pushes) is never stale.
export function snapshotIsStale(
  latestPush: string | null,
  lastCollectedAt: string | null | undefined,
): boolean {
  if (!latestPush) return false
  if (!lastCollectedAt) return true
  const pushMs = new Date(latestPush).getTime()
  const collectMs = new Date(lastCollectedAt).getTime()
  if (!Number.isFinite(pushMs) || !Number.isFinite(collectMs)) return false
  return pushMs > collectMs
}

// Whether ANY assignment in the classroom has a snapshot that is (probably)
// stale — the classroom-wide counterpart of snapshotIsStale, for the
// assignments page's freshness line.
//
// Compared PER ASSIGNMENT rather than "newest push in the classroom vs newest
// stamp in the file", which would hide the case this signal exists for: hw1
// collected a minute ago and hw2 pushed last week but never collected would
// read as fresh, because hw1's stamp is newer than hw2's push. One assignment
// out of date makes the classroom's data out of date.
//
// `collectedAt` is scores.json's per-bucket stamp map (slug -> ISO), and the
// per-slug stamp follows the same precedence effectiveCollectedAt documents:
// once ANY bucket carries a stamp the collector is stamp-aware, so a slug
// missing from the map was genuinely never collected and must not borrow a
// sibling's stamp — the org-wide `runCollectedAt` fallback applies only to a
// wholly unstamped file, written before the collector stamped buckets, where
// every run was org-wide and the run timestamp is the only signal there is.
// Borrowing per missing slug instead would resurrect the masking this function
// exists to prevent. Repo selection runs through latestAssignmentPush, so the
// sibling-slug guard ("hw1-bonus" under "hw1") applies here too.
//
// An options object, like effectiveCollectedAt below: the two slug lists share
// a type, and positional args let a transposition compile clean while silently
// re-latching the empty_repo badge this exclusion exists to prevent.
export function classroomSnapshotIsStale({
  repos,
  classroom,
  measuredSlugs,
  collectedAt,
  runCollectedAt = null,
  allSlugs = measuredSlugs,
}: {
  repos: GitHubRepo[] | null | undefined
  classroom: string
  // The slugs asked whether they are behind — collectable assignments only.
  measuredSlugs: string[]
  collectedAt: Record<string, string> | undefined
  runCollectedAt?: string | null
  // Every slug in the classroom, when that differs from the slugs being
  // measured: the sibling guard needs the complete list even where a slug is
  // excluded from the question (an empty_repo assignment is never collected,
  // so it has no stamp to compare against, but its repos still shadow a
  // slug-extending sibling). Defaults to the measured slugs.
  allSlugs?: string[]
}): boolean {
  if (!repos || measuredSlugs.length === 0) return false
  const collectorStampsBuckets = Object.keys(collectedAt ?? {}).length > 0
  return measuredSlugs.some((slug) =>
    snapshotIsStale(
      latestAssignmentPush(repos, classroom, slug, allSlugs),
      collectedAt?.[slug] ?? (collectorStampsBuckets ? null : runCollectedAt),
    ),
  )
}

// Newer of two ISO "last collected" timestamps. Lets the freshness view prefer a
// just-finished tracked run over the lagging status=completed query, which can
// still report the prior run while GitHub's Actions list catches up. Null-safe;
// unparseable inputs are discarded rather than winning the comparison.
export function latestCollectedAt(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const aMs = a ? new Date(a).getTime() : NaN
  const bMs = b ? new Date(b).getTime() : NaN
  const aOk = Number.isFinite(aMs)
  const bOk = Number.isFinite(bMs)
  if (!aOk && !bOk) return null
  if (!aOk) return b ?? null
  if (!bOk) return a ?? null
  return aMs >= bMs ? (a ?? null) : (b ?? null)
}

/**
 * The assignment page's "last collected" instant. Precedence:
 *
 * 1. Bucket stamp (`collected_at`) — authoritative for THIS assignment; the
 *    tracked run we just dispatched still participates (it's scoped to this
 *    very assignment and finishes before the scores.json refetch lands).
 * 2. No stamp but the collector is stamp-aware (another bucket carries one):
 *    the latest successful run may have been a scoped sync of a DIFFERENT
 *    assignment (the runs API can't see dispatch inputs), so borrowing the
 *    org-wide run timestamp would read "just collected" for a bucket no run
 *    walked. Only our own tracked dispatch counts.
 * 3. Wholly unstamped file — a pre-stamp collector, where every run was
 *    org-wide, so the run-based fallback stays sound.
 */
export function effectiveCollectedAt(params: {
  bucketCollectedAt: string | null
  collectorStampsBuckets: boolean
  lastRunCompletedAt: string | null
  trackedCompletedAt: string | null
}): string | null {
  const {
    bucketCollectedAt,
    collectorStampsBuckets,
    lastRunCompletedAt,
    trackedCompletedAt,
  } = params
  if (bucketCollectedAt) {
    return latestCollectedAt(bucketCollectedAt, trackedCompletedAt)
  }
  if (collectorStampsBuckets) return trackedCompletedAt
  return latestCollectedAt(lastRunCompletedAt, trackedCompletedAt)
}

// Whether a row passes the threshold. Ungraded when the assignment sets no
// threshold, or the row has no/zero/NaN max score.
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
  let submitted = 0
  let passing = 0
  let failing = 0
  let ungraded = 0
  let late = 0
  for (const row of rows) {
    // A pending live row (a submit/* release the collector hasn't ingested yet)
    // carries a placeholder 0/0 and no real grade — exclude it from every graded
    // tally (matching classAverage), so an uncollected submitter doesn't inflate
    // `submitted`/`ungraded` in the Metrics summary of the collected snapshot.
    if (row.pending) continue
    submitted++
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
    submitted,
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

export type SubmissionSort = "recent" | "oldest" | "name-first" | "name-last"

// Whether a sort orders by student name (either direction) — the roster-spine
// view that interleaves non-submitters — vs a time sort. Centralized so the
// table, pagination, and page-owner fan-out all agree on what "a name sort" is.
export function isNameSort(sort: SubmissionSort): boolean {
  return sort === "name-first" || sort === "name-last"
}

// The roster sort mode a name sort maps to; time sorts default to first-name
// (used only when a caller needs a mode regardless of the sort).
export function sortNameMode(sort: SubmissionSort): StudentSortMode {
  return sort === "name-last" ? "last" : "first"
}

// Who has accepted an INDIVIDUAL assignment, derived from the org repo list: a
// student accepted iff `<classroom>-<assignment>-<username>` exists. Independent
// of submission — a repo can exist without a graded push.
//
// Forward-constructs each student's expected repo name rather than reverse-
// parsing the prefix, which would over-match a sibling whose slug extends this
// one (assignment "hw" capturing `cs-hw-bonus-alice` from "hw-bonus"). Group
// assignments are excluded (repo named after the owner, not each member).
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

// All existing assignment repo names for a bulk per-repo teacher action (e.g.
// opening every Feedback PR — issue #347). Mode-aware: individual repos are
// forward-constructed per accepted student (studentRepoName), group repos come
// from existingGroupRepos (reverse-parsed, sibling-guarded). Deduped and
// lowercased to match the org repo list. Empty when the inputs aren't ready.
export function assignmentRepoNames(params: {
  isGroup: boolean
  isTeam?: boolean
  repos: GitHubRepo[] | null | undefined
  classroom: string
  assignment: string
  students: Student[]
  siblingSlugs?: string[]
}): string[] {
  const {
    isGroup,
    isTeam,
    repos,
    classroom,
    assignment,
    students,
    siblingSlugs,
  } = params
  if (isTeam) {
    return existingTeamRepos(repos, classroom, assignment).map(
      (r) => r.repoName,
    )
  }
  if (isGroup) {
    return existingGroupRepos(repos, classroom, assignment, siblingSlugs).map(
      (r) => r.repoName,
    )
  }
  const accepted = acceptedUsernames(repos, classroom, assignment, students)
  return [...accepted].map((login) =>
    studentRepoName(classroom, assignment, login),
  )
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

// Team-mode repos that exist for the assignment — the team analog of
// existingGroupRepos, keyed by the `group-<n>` owner segment. MODE-GATED by
// the caller: the parse is shape-exact (`<classroom>-<assignment>-group-<n>`,
// counters start at 1), and only the assignment's mode decides that the
// `group-<n>` segment is a counter rather than a login.
export function existingTeamRepos(
  repos: GitHubRepo[] | null | undefined,
  classroom: string,
  assignment: string,
): GroupRepo[] {
  if (!repos) return []
  const out: GroupRepo[] = []
  for (const repo of repos) {
    const n = parseGroupRepoCounter(repo.name, classroom, assignment)
    if (n === null) continue
    out.push({
      owner: `${GROUP_REPO_SEGMENT}${n}`,
      repoName: repo.name.toLowerCase(),
    })
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
// states that would otherwise collapse into a flat "Not submitted":
//   - no-team: team assignment — the student is on no group team.
//   - no-group: legacy group assignment — the student isn't credited on any
//     submitting group's repo (group repos are named after the founder, so a
//     never-joined student has nothing to reconcile against).
//   - accepted-not-submitted: individual — a repo exists (accepted) but no push.
//   - not-accepted: individual — never accepted, so no repo.
//   - not-submitted: acceptance data unavailable (repos not loaded yet) — a
//     neutral fallback so a transient empty repo list can't mislabel everyone.
export type NonSubmitterStatus =
  | "no-group"
  | "no-team"
  | "accepted-not-submitted"
  | "not-accepted"
  | "not-submitted"

export function nonSubmitterStatus(
  username: string,
  {
    isGroup,
    isTeam,
    acceptedUsernames,
  }: {
    isGroup: boolean
    isTeam?: boolean
    acceptedUsernames?: Set<string>
  },
): NonSubmitterStatus {
  if (isTeam) return "no-team"
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
// The runtime list backs the route's ?status= search-param validation.
export const STATUS_SELECT_VALUES = [
  "all",
  "submitted",
  "on-time",
  "late",
  "not-submitted",
  "accepted",
  "not-accepted",
] as const
export type StatusSelectValue = (typeof STATUS_SELECT_VALUES)[number]

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

// Whether the current sort/filter combination can hide not-yet-collected
// (live-only pending) submitters from a live-capable viewer. The page-scoped
// fan-out builds its owner set from the SNAPSHOT spine, so a live-only owner
// (pushed, not yet collected) can be placed only when the spine walks the whole
// roster in name order with no grade-implying filter. A time sort, or a status/
// passing filter that implies a grade, drops that owner from the page's owner
// set until a collect ingests it. Used to surface an honest hint instead of
// hiding the sort/status controls. False when the overlay doesn't apply.
export function pendingMayHide(
  liveCapable: boolean,
  sort: SubmissionSort,
  filters: SubmissionFilters,
): boolean {
  if (!liveCapable) return false
  return (
    !isNameSort(sort) ||
    filters.submission !== "all" ||
    filters.passing !== "all"
  )
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

  // Name sort key for a row, in the active mode: resolve the primary credited
  // login to its roster student and reuse the shared first/last sort keys, so
  // rows order by the same key the roster spine does. Falls back to the login.
  const nameKey = (row: SubmissionRow) => {
    const login = row.usernames[0] ?? ""
    const key = studentSortKeyFor(
      resolveStudent(login, students),
      sortNameMode(sort),
    )
    return key || login.toLowerCase()
  }

  // Key each row's name + time once before sorting: nameKey scans the roster
  // linearly, so calling it in the comparator would repeat it O(rows·log rows).
  const keyed = filtered.map((row) => ({
    row,
    name: nameKey(row),
    time: new Date(row.datetime).getTime(),
  }))

  keyed.sort((a, b) => {
    switch (sort) {
      case "oldest":
        return a.time - b.time
      case "name-first":
      case "name-last":
        return a.name.localeCompare(b.name, undefined, NAME_COLLATION)
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

// Rows for the exported gradebook CSV. Every row carries the student's names
// (resolved from the roster) alongside their login(s), and the whole set is
// ordered by last name — matching a gradebook so a teacher can transcribe
// grades top-to-bottom. Column order and the empty-string-vs-literal typing are
// the contract downstream sheets rely on — keep them stable.
export type ScoresCsvRow = {
  name: string
  first_name: string
  last_name: string
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
  students: Student[],
  // The teacher's active sort, so the exported file matches the on-screen order.
  // Name sorts order the whole set by name (first or last); time sorts put
  // submitters in submission-time order, then the (timeless) non-submitters.
  // Defaults to last-name so existing callers/tests keep the gradebook order.
  sort: SubmissionSort = "name-last",
): ScoresCsvRow[] {
  // Carry the resolved student alongside each row so the final ordering can use
  // the shared name comparator (last name, then first, then username) — the
  // same collation and identity tie-break every other roster view uses, so two
  // same-named students order deterministically rather than by input order.
  // `time` carries the row's submission instant for a time sort (non-submitters
  // have none and sort last).
  type Keyed = { row: ScoresCsvRow; student: Student; time: number | null }

  // The name columns, escaped against spreadsheet formula injection: self-
  // reported names are as untrusted as the login/URL columns.
  const nameColumns = (student: Student) => ({
    name: escapeCsvFormulaInjection(
      nameFromParts(student.first_name, student.last_name),
    ),
    first_name: escapeCsvFormulaInjection(student.first_name.trim()),
    last_name: escapeCsvFormulaInjection(student.last_name.trim()),
  })

  // Resolve each row's names from the roster in one pass: a login→Student map
  // keyed like findByUsername (trimmed + lowercased), so building the export
  // doesn't rescan the whole roster once per submitted row.
  const byLogin = new Map<string, Student>()
  for (const student of students) {
    const login = student.username.trim().toLowerCase()
    if (login && !byLogin.has(login)) byLogin.set(login, student)
  }
  const studentFor = (login: string): Student =>
    byLogin.get(login.trim().toLowerCase()) ?? placeholderStudent(login)

  const submittedRows: Keyed[] = scoresInfo.map(
    ({ usernames, score, datetime, submissionCount, late, ...rest }) => {
      // Names come from the roster, keyed on the primary credited login (group
      // rows are credited to all members; the first is the owner/founder, which
      // is how the dashboard already derives a group's display name).
      const student = studentFor(usernames[0] ?? "")
      const ms = new Date(datetime).getTime()
      return {
        row: {
          ...nameColumns(student),
          // Free-text columns can carry student-influenceable content (a repo/
          // commit/release/review URL, a group's joined logins), so neutralize
          // spreadsheet formula injection on them. The numeric/enum/timestamp
          // columns below are our own generated values and must round-trip
          // byte-exact, so they are NOT escaped.
          usernames: escapeCsvFormulaInjection(usernames.join(", ")),
          // A pending live row (submitted, not yet collected) has no real grade
          // — export a blank score, not a 0, so importing the CSV can't record
          // a graded zero for a student who actually submitted.
          score: rest.pending ? "" : score,
          max_score: rest.pending ? "" : rest["max-score"],
          submissions: submissionCount,
          // A detection-only row can still be dateless (e.g. a milestone tag
          // whose commit lookup failed) — export a blank rather than crashing
          // on Invalid Date. Reuse the `ms` parsed above rather than re-parsing.
          submitted_at: isoOrBlank(ms),
          late: late ? "yes" : "no",
          commit: escapeCsvFormulaInjection(rest.commit),
          review: escapeCsvFormulaInjection(rest.review),
          release: escapeCsvFormulaInjection(rest.release),
        },
        student,
        time: Number.isFinite(ms) ? ms : null,
      }
    },
  )

  const nonSubmittedRows: Keyed[] = nonSubmitters.map((student) => ({
    row: {
      ...nameColumns(student),
      usernames: escapeCsvFormulaInjection(student.username),
      // No submission means no grade — leave the score cell empty (not 0) so
      // importing the CSV can't record a graded zero for a student who simply
      // hasn't been graded. max_score is likewise blank.
      score: "",
      max_score: "",
      submissions: 0,
      submitted_at: "",
      late: "",
      commit: "",
      review: "",
      release: "",
    },
    student,
    time: null,
  }))

  const all = [...submittedRows, ...nonSubmittedRows]

  if (sort === "recent" || sort === "oldest") {
    // Time order: rows with a submission instant first (newest- or oldest-first),
    // then the timeless non-submitters, name-ordered among themselves for a
    // stable tail. Mirrors the table's buildSortedDisplayItems (submitters in
    // sort order, then non-submitters).
    const byLastName = compareStudentsByName("last")
    return all
      .toSorted((a, b) => {
        if (a.time !== null && b.time !== null) {
          return sort === "oldest" ? a.time - b.time : b.time - a.time
        }
        if (a.time !== null) return -1
        if (b.time !== null) return 1
        return byLastName(a.student, b.student)
      })
      .map((keyed) => keyed.row)
  }

  // Name sort: order the whole set by the chosen name mode.
  const byName = compareStudentsByName(sortNameMode(sort))
  return all
    .toSorted((a, b) => byName(a.student, b.student))
    .map((keyed) => keyed.row)
}

// The ISO form of a parsed epoch-ms instant, or "" for an absent/unparseable
// one (NaN). Takes ms rather than the raw string so callers that already parsed
// it don't re-parse.
function isoOrBlank(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ""
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
// whole list as one sequence.
export type DisplayItem =
  | { kind: "row"; row: SubmissionRow }
  | { kind: "nonSubmitter"; student: Student }
  | { kind: "groupRepo"; repo: GroupRepo }

// The default and offered "Show N entries" page sizes (mirrors the reference
// gradebook UI). Default is the first entry.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
export const DEFAULT_PAGE_SIZE: number = PAGE_SIZE_OPTIONS[0]

// The ordered display list for an INDIVIDUAL assignment: one item per roster
// student in the roster's (name-sorted) order, resolved to the student's
// submission row (owner match, case-insensitive) or a non-submitter item. A
// student in neither filtered set is omitted. Interleaving by the roster spine
// — not concatenating the two groups — makes a page a clean roster slice.
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

// Build the display list for a GROUP assignment in name order: one item per
// group founder, name-sorted in the given mode (first- or last-name), resolved
// to the founder's submitted row when one exists (owner match) else an
// unsubmitted group-repo row. The group analog of buildRosterDisplayItems.
// `rows` are the (filtered) submitted group rows; `groupRepos` the unsubmitted
// group repos.
export function buildGroupRosterDisplayItems(
  rows: SubmissionRow[],
  groupRepos: GroupRepo[],
  students: Student[],
  mode: StudentSortMode = "first",
): DisplayItem[] {
  const submitted = rows.map<DisplayItem>((row) => ({ kind: "row", row }))
  const unsubmitted = groupRepos.map<DisplayItem>((repo) => ({
    kind: "groupRepo",
    repo,
  }))
  // Precompute the name map once so the comparator is O(1) per compare (getName
  // would re-scan the roster each call).
  const names = buildNameKeyLookup(students, mode)
  return [...submitted, ...unsubmitted].sort((a, b) =>
    ownerSortKey(displayItemOwner(a), names).localeCompare(
      ownerSortKey(displayItemOwner(b), names),
      undefined,
      NAME_COLLATION,
    ),
  )
}

// Build the ordered display list for a GROUP assignment under a non-name sort:
// submitted group rows first (in the caller's sort order), then unsubmitted
// group repos.
export function buildGroupDisplayItems(
  rows: SubmissionRow[],
  groupRepos: GroupRepo[],
): DisplayItem[] {
  return [
    ...rows.map<DisplayItem>((row) => ({ kind: "row", row })),
    ...groupRepos.map<DisplayItem>((repo) => ({ kind: "groupRepo", repo })),
  ]
}

// Build the display list for an INDIVIDUAL assignment under a non-name sort:
// the already-sorted submitted rows first, then non-submitters. Preserves the
// caller's chosen sort for the submitted rows rather than forcing the roster's
// name order.
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

// The repo-owner login for a display item. Submitted rows and group repos are
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
// once so the group name-ordering doesn't call getName (an O(n) roster scan)
// inside a comparator — which turns an O(n log n) sort into O(n^2). The value
// mirrors getName exactly: the display name, or "" when the login isn't on the
// roster or the row has no name.
export function buildNameKeyLookup(
  students: Student[],
  mode: StudentSortMode = "first",
): Map<string, string> {
  const map = new Map<string, string>()
  for (const student of students) {
    const login = student.username.trim().toLowerCase()
    if (!login) continue
    const name =
      mode === "last"
        ? nameFromParts(student.last_name, student.first_name)
        : nameFromParts(student.first_name, student.last_name)
    map.set(login, name.toLowerCase())
  }
  return map
}

// A single owner's group SORT key from the precomputed name map: display name
// when the founder is on the roster with a name, else the login — lowercased.
// (Mirrors the prior `getName(owner) || owner`.)
function ownerSortKey(owner: string, names: Map<string, string>): string {
  return names.get(owner.trim().toLowerCase()) || owner.toLowerCase()
}

// The repo owners on the CURRENTLY RENDERED page, in display order under the
// active sort, so the live fan-out reads exactly the repos the user sees. Built
// from the SNAPSHOT display list (same builders SubmissionsTable uses) — it must
// NOT be fed the live-merged rows: a live-only pending row exists only after the
// fan-out, so using it here would feed the fan-out's output back into its input
// and loop. `nonSubmitter`/`groupRepo` items resolve to their owner login.
export function displayPageOwners({
  isGroup,
  sort,
  students,
  rows,
  nonSubmitters,
  groupRepos,
  page,
  pageSize,
}: {
  isGroup: boolean
  sort: SubmissionSort
  students: Student[]
  rows: SubmissionRow[]
  nonSubmitters: Student[]
  groupRepos: GroupRepo[]
  page: number
  pageSize: number
}): string[] {
  const items = isGroup
    ? isNameSort(sort)
      ? buildGroupRosterDisplayItems(
          rows,
          groupRepos,
          students,
          sortNameMode(sort),
        )
      : buildGroupDisplayItems(rows, groupRepos)
    : isNameSort(sort)
      ? buildRosterDisplayItems(students, rows, nonSubmitters)
      : buildSortedDisplayItems(rows, nonSubmitters)
  const seen = new Set<string>()
  const owners: string[] = []
  for (const item of paginateDisplayItems(items, pageSize, page)) {
    const owner = displayItemOwner(item).trim()
    if (!owner) continue
    const key = owner.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    owners.push(owner)
  }
  return owners
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
