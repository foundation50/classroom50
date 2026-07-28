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
): { verdict: EnrollmentVerdict; isLoading: boolean } {
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
  const { role, isLoading: loadingRole } = useClassroomRole(
    org,
    classroom,
    username,
  )

  const isStaff = role === "teacher" || role === "hta" || role === "ta"
  const student = membershipFromQuery(
    studentQuery.isSuccess,
    studentQuery.error,
  )

  // Loading = the student probe is fetching (incl. retries) OR its result isn't
  // in yet while enabled, OR the staff-role reads are still resolving. Holding
  // on the enabled-but-not-yet-settled window is what prevents the accept card
  // from flashing before the verdict lands and then flipping to "not available".
  const studentSettled = studentQuery.isSuccess || studentQuery.isError
  const isLoading =
    studentQuery.fetchStatus === "fetching" ||
    (enabled && !studentSettled) ||
    loadingRole

  let verdict: EnrollmentVerdict
  if (isStaff || student === "member") {
    verdict = "enrolled"
  } else if (student === "non-member" && !loadingRole) {
    verdict = "not-enrolled"
  } else {
    verdict = "unresolved"
  }

  return { verdict, isLoading }
}

export default useClassroomEnrollment
