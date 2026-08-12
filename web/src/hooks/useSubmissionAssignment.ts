import { useMemo } from "react"

import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import type { Assignment } from "@/types/classroom"

// A stable empty list so consumers memoizing on `assignments` don't churn every
// render while the underlying query is still `undefined`.
const EMPTY_ASSIGNMENTS: Assignment[] = []

// Where an assignment's metadata is read from. The rule (single-sourced here):
//   - "config" — the PRIVATE config repo (classroom50/<classroom>/assignments
//     .json), authenticated. Staff-only; students get a 404.
//   - "pages"  — the PUBLIC GitHub Pages projection, unauthenticated. The
//     student-safe source, since students can't read the config repo.
export type AssignmentSource = "config" | "pages"

// One role-aware reader for a submission view's assignment metadata. The two
// submission views (teacher gradebook, student page) reach the same
// `Assignment` shape through this hook instead of each hard-coding its own
// transport: the teacher page (staff, gated by the route) passes
// source:"config"; the student page passes source:"pages" + the capability
// secret. Both underlying queries are always mounted but only the selected
// source is enabled, so hook order is stable and the inactive source costs no
// request.
export function useSubmissionAssignment(
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  options: {
    source: AssignmentSource
    // Capability-URL secret for a protected classroom's Pages path. Ignored for
    // the config source (the authenticated repo read needs no secret).
    secret?: string
  },
): {
  assignment: Assignment | undefined
  // The full assignment list from the selected source, for callers that need
  // siblings (e.g. sibling-slug repo-prefix disambiguation on the teacher page).
  assignments: Assignment[]
  isLoading: boolean
  isError: boolean
} {
  const useConfig = options.source === "config"

  const configQuery = useGetClassroomAssignments(org, classroom, {
    enabled: useConfig,
  })
  const pagesQuery = usePagesAssignments(org, classroom, options.secret, {
    enabled: !useConfig,
    assignmentSlug: assignment,
  })

  // Stable list reference: fall back to the shared EMPTY_ASSIGNMENTS (not a
  // fresh []) while the query is undefined, so a caller memoizing on
  // `assignments` doesn't recompute every render during load.
  const assignments = useMemo(
    () =>
      useConfig
        ? (configQuery.data?.assignments ?? EMPTY_ASSIGNMENTS)
        : (pagesQuery.data ?? EMPTY_ASSIGNMENTS),
    [useConfig, configQuery.data, pagesQuery.data],
  )

  if (useConfig) {
    return {
      assignment: assignments.find((a) => a.slug === assignment),
      assignments,
      isLoading: configQuery.isLoading,
      isError: configQuery.isError,
    }
  }
  return {
    assignment: pagesQuery.assignment,
    assignments,
    isLoading: pagesQuery.isLoading,
    isError: pagesQuery.isError,
  }
}

export default useSubmissionAssignment
