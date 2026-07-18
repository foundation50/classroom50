import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { myTeamsQuery } from "@/github-core/queries"
import {
  parseStudentClassroomSlug,
  parseClassroomTeamSlug,
  parseBareClassroomSlug,
} from "@/util/teamSlug"
import { parseTeamDescription } from "@/util/teamDescription"

// A classroom a student belongs to, derived entirely from their own team
// memberships + the team's bootstrap description — never the config repo.
export type StudentClassroom = {
  classroom: string
  // Display fields lifted from the classroom50/team/v1 team description, so a
  // card renders without a Pages round-trip. Absent for a pre-schema team.
  name?: string
  term?: string
  active?: boolean
  // Capability secret for an unlisted classroom; unlocks the published Pages
  // assignments even before the student accepts anything. Absent when listed or
  // when the team predates the schema.
  secret?: string
}

export type UseStudentClassroomsResult = {
  classrooms: StudentClassroom[]
  isLoading: boolean
  isError: boolean
  roleResolved: boolean
  refetch: () => void
}

// Enumerate the classrooms a student belongs to IN THIS ORG from GET /user/teams
// (self-scoped, returns the viewer's own secret teams with their descriptions) —
// no config-repo access, which a plain member lacks. Parses each membership's
// slug (student or staff) to a classroom and lifts the bootstrap record from the
// student team's description.
//
// Fail-closed tri-state mirrors useOrgStaff: a settled success yields the
// (possibly empty) list with roleResolved=true; an in-flight/transient read
// holds (never flash an empty list); a settled error surfaces isError so the
// caller can offer retry.
export function useStudentClassrooms(
  org: string | undefined,
): UseStudentClassroomsResult {
  const client = useGitHubClient()
  const { user } = useGithubAuth()

  const enabled = Boolean(org && user?.login)
  const teamsQuery = useQuery({ ...myTeamsQuery(client), enabled })

  // Dedup by classroom: a TA or teacher previewing as a student may hold both a
  // student and a staff team for the same classroom. The student team is the
  // authoritative source for the bootstrap description (staff teams carry none),
  // so prefer its record when merging. Memoized on the query data + org so the
  // per-team zod parse and the returned array reference are stable across
  // renders (an unstable reference would defeat useStudentClassroomSummaries'
  // downstream memo).
  const classrooms = useMemo<StudentClassroom[]>(() => {
    const byClassroom = new Map<string, StudentClassroom>()
    for (const team of teamsQuery.data ?? []) {
      if (team.organization.login !== org) continue
      const student = parseStudentClassroomSlug(team.slug)
      const staff = parseClassroomTeamSlug(team.slug)
      // A slug like `classroom50-ml-ta` is ambiguous: the STUDENT team of a
      // role-suffixed classroom (`ml-ta`) is byte-identical to the TA team of
      // classroom `ml`. The bootstrap description disambiguates — only a student
      // team carries a classroom50/team/v1 record (staff teams get none). So a
      // slug that parses as staff but carries a valid record is really the student
      // team of the role-suffixed classroom: its classroom is the whole
      // post-prefix slug (`ml-ta`), and we lift its name/term/secret. Trust the
      // record over the staff parse.
      const desc = parseTeamDescription(team.description)
      const bareStudent = parseBareClassroomSlug(team.slug)
      const isStudentByRecord =
        Boolean(staff) && desc.schema !== undefined && Boolean(bareStudent)
      const classroom = isStudentByRecord
        ? bareStudent!.classroom
        : (student?.classroom ?? staff?.classroom)
      if (!classroom) continue

      const existing = byClassroom.get(classroom)
      if (student || isStudentByRecord) {
        // Student team: authoritative for the bootstrap record.
        byClassroom.set(classroom, {
          classroom,
          name: desc.name,
          term: desc.term,
          active: desc.active,
          secret: desc.secret,
        })
      } else if (!existing) {
        // Staff-only membership (no student team seen yet): record the classroom
        // so it still appears; a later student team overwrites with its record.
        byClassroom.set(classroom, { classroom })
      }
    }
    return Array.from(byClassroom.values()).sort((a, b) =>
      (a.name ?? a.classroom).localeCompare(b.name ?? b.classroom),
    )
  }, [teamsQuery.data, org])

  const roleResolved = Boolean(org) && teamsQuery.isSuccess
  const isLoading = !roleResolved && teamsQuery.fetchStatus === "fetching"
  const isError = !roleResolved && !isLoading && teamsQuery.isError

  return {
    classrooms,
    isLoading,
    isError,
    roleResolved,
    refetch: () => void teamsQuery.refetch(),
  }
}

export default useStudentClassrooms
