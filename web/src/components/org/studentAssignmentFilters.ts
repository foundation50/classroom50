// Pure search/filter/sort for the STUDENT per-classroom assignment list, over
// the already-loaded published assignments plus the student's accepted-slug set.
// No fetches, no React (mirrors assignmentList.ts) so it's testable in isolation.
// Adds the student-only `status` dimension (accepted vs not) the teacher list has
// no concept of, and defaults to due-soonest-first.

import type { Assignment } from "@/types/classroom"
import { dueDeadlineInstant } from "@/util/formatDate"
import type { StudentAssignmentSort } from "@/lib/studentAssignmentListPrefs"

// Re-exported so the component and its toolbar import the sort type from the
// filters module alongside the filter types. Owned by the prefs lib (a leaf
// layer) so persistence can reference it without importing components/.
export type { StudentAssignmentSort }

export type StatusFilter = "all" | "todo" | "accepted"
export type TypeFilter = "all" | "individual" | "group"
export type DueFilter = "all" | "overdue"

export type StudentAssignmentFilters = {
  status: StatusFilter
  type: TypeFilter
  due: DueFilter
}

export const DEFAULT_STUDENT_SORT: StudentAssignmentSort = "due-asc"

export const DEFAULT_STUDENT_FILTERS: StudentAssignmentFilters = {
  status: "all",
  type: "all",
  due: "all",
}

// One source of "has a usable due date" for the due facet and sort, so a
// present-but-malformed `due` never falls through a bucket (matches the app's
// end-of-local-day deadline semantics).
const dueInstant = (assignment: Assignment): Date | null =>
  assignment.due ? dueDeadlineInstant(assignment.due) : null

// True when the assignment has a parseable release date still in the future.
// Fails open: absent or unparseable available_from is treated as released.
const isUnreleased = (assignment: Assignment, now: number): boolean => {
  if (!assignment.available_from) return false
  const instant = dueDeadlineInstant(assignment.available_from)
  return instant !== null && instant.getTime() > now
}

const matchesQuery = (assignment: Assignment, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    assignment.name.toLowerCase().includes(q) ||
    assignment.slug.toLowerCase().includes(q)
  )
}

const matchesFilters = (
  assignment: Assignment,
  filters: StudentAssignmentFilters,
  accepted: boolean,
  now: number,
): boolean => {
  // Not-yet-released assignments stay hidden until their release date passes,
  // unless the student already accepted it (their repo exists).
  if (!accepted && isUnreleased(assignment, now)) return false
  if (filters.status === "accepted" && !accepted) return false
  if (filters.status === "todo" && accepted) return false
  if (filters.type !== "all" && assignment.mode !== filters.type) return false
  if (filters.due === "overdue") {
    const instant = dueInstant(assignment)
    if (!instant || instant.getTime() >= now) return false
  }
  return true
}

// Sort a copy; never mutate the input. Missing/unparseable due dates sort last
// in both directions (a stable, documented tie-break).
const sortAssignments = (
  assignments: Assignment[],
  sort: StudentAssignmentSort,
): Assignment[] => {
  const list = [...assignments]
  const byName = (a: Assignment, b: Assignment) => a.name.localeCompare(b.name)

  const byDue = (a: Assignment, b: Assignment, dir: 1 | -1) => {
    const ta = dueInstant(a)?.getTime() ?? null
    const tb = dueInstant(b)?.getTime() ?? null
    if (ta === null && tb === null) return byName(a, b)
    if (ta === null) return 1
    if (tb === null) return -1
    return (ta - tb) * dir || byName(a, b)
  }

  switch (sort) {
    case "due-asc":
      return list.sort((a, b) => byDue(a, b, 1))
    case "due-desc":
      return list.sort((a, b) => byDue(a, b, -1))
    case "name-asc":
      return list.sort(byName)
    case "name-desc":
      return list.sort((a, b) => byName(b, a))
  }
}

export function filterAndSortStudentAssignments(
  assignments: Assignment[],
  {
    query,
    filters,
    sort,
    acceptedSlugs,
    now = Date.now(),
  }: {
    query: string
    filters: StudentAssignmentFilters
    sort: StudentAssignmentSort
    acceptedSlugs: ReadonlySet<string>
    now?: number
  },
): Assignment[] {
  const filtered = assignments.filter(
    (a) =>
      matchesQuery(a, query) &&
      matchesFilters(a, filters, acceptedSlugs.has(a.slug), now),
  )
  return sortAssignments(filtered, sort)
}
