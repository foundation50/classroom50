import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import type { Assignment } from "@/types/classroom"

// A stable empty list (not a fresh `[]`) so a caller memoizing on `assignments`
// doesn't churn while the underlying query is still `undefined`. react-query
// keeps a resolved `data` referentially stable, so this covers the load window
// and no memo is needed (matches the useGetStudents idiom).
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

  const active = useConfig ? configQuery : pagesQuery
  const assignments = useConfig
    ? (configQuery.data?.assignments ?? EMPTY_ASSIGNMENTS)
    : (pagesQuery.data ?? EMPTY_ASSIGNMENTS)

  return {
    // The config path finds by slug over its list; the pages path delegates the
    // find to usePagesAssignments (via assignmentSlug).
    assignment: useConfig
      ? assignments.find((a) => a.slug === assignment)
      : pagesQuery.assignment,
    assignments,
    isLoading: active.isLoading,
    isError: active.isError,
  }
}

export default useSubmissionAssignment
