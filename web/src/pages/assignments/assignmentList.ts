// Pure search/filter/sort primitives for the teacher assignments list, over the
// already-loaded assignment array — no fetches, no React, so the logic is
// reusable and testable in isolation (mirrors submissions/dashboard.ts).

import type { Assignment } from "@/types/classroom"
import { dueDeadlineInstant } from "@/util/formatDate"

export type AssignmentSort =
  "name-asc" | "name-desc" | "due-asc" | "due-desc" | "type"

export type TypeFilter = "all" | "individual" | "group"
export type DueFilter = "all" | "has-due" | "no-due" | "overdue"

export type AssignmentFilters = {
  type: TypeFilter
  due: DueFilter
}

export const DEFAULT_SORT: AssignmentSort = "name-asc"

export const DEFAULT_FILTERS: AssignmentFilters = {
  type: "all",
  due: "all",
}

// The single source of "does this assignment have a usable due date" for every
// due facet and the due sort, so a present-but-malformed `due` never falls
// through a bucket. Matches the rest of the app's deadline semantics (a bare
// YYYY-MM-DD is end-of-local-day, not UTC midnight).
const dueInstant = (assignment: Assignment): Date | null =>
  assignment.due ? dueDeadlineInstant(assignment.due) : null

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
  filters: AssignmentFilters,
  now: number,
): boolean => {
  if (filters.type !== "all" && assignment.mode !== filters.type) return false

  if (filters.due !== "all") {
    const instant = dueInstant(assignment)
    switch (filters.due) {
      case "has-due":
        if (!instant) return false
        break
      case "no-due":
        if (instant) return false
        break
      case "overdue":
        if (!instant || instant.getTime() >= now) return false
        break
    }
  }

  return true
}

// Sort a copy; never mutate the input. Missing/unparseable due dates sort last
// in both directions (a stable, documented tie-break).
const sortAssignments = (
  assignments: Assignment[],
  sort: AssignmentSort,
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
    case "name-asc":
      return list.sort(byName)
    case "name-desc":
      return list.sort((a, b) => byName(b, a))
    case "due-asc":
      return list.sort((a, b) => byDue(a, b, 1))
    case "due-desc":
      return list.sort((a, b) => byDue(a, b, -1))
    case "type":
      return list.sort((a, b) => a.mode.localeCompare(b.mode) || byName(a, b))
  }
}

export function filterAndSortAssignments(
  assignments: Assignment[],
  {
    query,
    filters,
    sort,
    now = Date.now(),
  }: {
    query: string
    filters: AssignmentFilters
    sort: AssignmentSort
    now?: number
  },
): Assignment[] {
  const filtered = assignments.filter(
    (a) => matchesQuery(a, query) && matchesFilters(a, filters, now),
  )
  return sortAssignments(filtered, sort)
}
