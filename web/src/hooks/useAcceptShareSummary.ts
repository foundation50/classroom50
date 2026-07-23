import { useMemo } from "react"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { hasStudentEnrollment } from "@/util/classroomRoleUI"
import {
  resolveAcceptShareSummary,
  type AcceptShareSummary,
} from "@/pages/submissions/acceptShareSummary"

// Roster-readiness summary for the assignment share (accept-link) modal: how
// many students can accept, and whether to warn that none can yet. Mirrors
// useEmptyRosterWarning — owns its own roster reads (React Query dedupes the
// shared team-members query, so this adds no fetch) so the page just consumes
// the resolved summary instead of threading roster internals through.
//
// Both terms are STUDENT-scoped: roleCounts.student is already student-only, and
// pending is filtered to rows carrying the student role — counts.pending tallies
// EVERY pending row (incl. staff-team invites), so a lone pending co-teacher/TA
// would otherwise read as "1 student can accept" and silence the warning (the
// #376 case this guards). Pending counts because the accept page auto-accepts a
// pending org invite inline (useAcceptAndVerifyMembership).
const useAcceptShareSummary = (
  org: string | undefined,
  classroom: string | undefined,
): AcceptShareSummary => {
  const { students } = useGetStudents(org, classroom)
  const { rows, roleCounts, pendingHidden, isLoading, isError } = useTeamRoster(
    org ?? "",
    classroom ?? "",
    students,
  )

  const pendingStudents = useMemo(
    () =>
      rows.filter((r) => r.state === "pending" && hasStudentEnrollment(r))
        .length,
    [rows],
  )

  return resolveAcceptShareSummary({
    isLoading,
    isError,
    enrolledStudents: roleCounts.student,
    pending: pendingStudents,
    pendingHidden,
  })
}

export default useAcceptShareSummary
