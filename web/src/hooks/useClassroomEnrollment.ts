import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { classroomTeamSlug } from "@/util/teamSlug"
import { membershipFromQuery } from "@/authz"
import { teamMembershipQuery, useClassroomRole } from "./useClassroomRole"

// A settled enrollment verdict for the accept gate. "unresolved" means a team
// read is still in flight or a transient error left the verdict unknown — the
// caller must fail OPEN on it (never lock out a real student on a blip).
export type EnrollmentVerdict = "enrolled" | "not-enrolled" | "unresolved"

// Whether the viewer may accept in this classroom: enrolled = on the
// `classroom50-<classroom>` student team, OR holding a classroom staff role
// (teacher/hta/ta). Org owners are NOT resolved here — that bypass lives at the
// call site, which already holds the org membership.
//
// The student-team slug is derived (a student can't read classroom.json for the
// GitHub-assigned slug); on a slug-collision rewrite the derived slug 404s and
// reads as non-member, so a miss never grants false access — the same
// safe-degrade useClassroomRole relies on.
export function useClassroomEnrollment(
  org: string | undefined,
  classroom: string | undefined,
  username: string | undefined,
): { verdict: EnrollmentVerdict; isLoading: boolean; refetch: () => void } {
  const client = useGitHubClient()
  const enabled = Boolean(org && classroom && username)
  const studentSlug = org && classroom ? classroomTeamSlug(classroom) : ""

  const studentQuery = useQuery({
    ...teamMembershipQuery(client, org ?? "", studentSlug, username ?? ""),
    enabled,
  })

  // Reuse the full role resolution for the staff bypass (teacher/hta/ta). Its
  // student-team probe collapses a non-member to the "student" default, so it
  // can't tell an enrolled student from an outsider — the dedicated
  // studentQuery above supplies that signal.
  const {
    role,
    isLoading: loadingRole,
    refetch: refetchRole,
  } = useClassroomRole(org, classroom, username)

  const isStaff = role === "teacher" || role === "hta" || role === "ta"
  const student = membershipFromQuery(
    studentQuery.isSuccess,
    studentQuery.error,
  )

  const isLoading = studentQuery.fetchStatus === "fetching" || loadingRole

  let verdict: EnrollmentVerdict
  if (isStaff || student === "member") {
    verdict = "enrolled"
  } else if (student === "non-member" && !loadingRole) {
    verdict = "not-enrolled"
  } else {
    verdict = "unresolved"
  }

  const { refetch: refetchStudent } = studentQuery
  const refetch = () => {
    void refetchStudent()
    refetchRole()
  }

  return { verdict, isLoading, refetch }
}

export default useClassroomEnrollment
