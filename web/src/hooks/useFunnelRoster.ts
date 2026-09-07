import { useMemo } from "react"

import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { hasStudentEnrollment } from "@/util/classroomRoleUI"

export type FunnelRoster = {
  // Lowercased logins of enrolled members holding the student role, and of
  // those holding any staff role (teacher, head TA, TA). A person on both a
  // student and a staff team is in both sets, so a union dedupes them.
  // undefined while the authoritative source resolves or when it's unknowable.
  studentLogins: ReadonlySet<string> | undefined
  staffLogins: ReadonlySet<string> | undefined
  isLoading: boolean
  // A team read failed; callers degrade instead of showing a wrong number.
  isError: boolean
  // The roster is unknowable to this viewer (non-owner off the secret student
  // team, no roster.csv students). Settled, not loading.
  isUnknown: boolean
}

// The assignments table's funnel roster: who is counted in the Accepted /
// Submitted denominators, keyed by login so the numerators can be joined to
// the same people. Sibling of useStudentCount, which only needs the number.
const useFunnelRoster = (
  org: string | undefined,
  classroom: string | undefined,
): FunnelRoster => {
  const { students } = useGetStudents(org, classroom)
  const { rows, isLoading, isError, studentRosterKnown } = useTeamRoster(
    org ?? "",
    classroom ?? "",
    students,
  )
  const isUnknown = !isLoading && !isError && !studentRosterKnown

  const { studentLogins, staffLogins } = useMemo(() => {
    const studentSet = new Set<string>()
    const staffSet = new Set<string>()
    for (const row of rows) {
      if (row.state !== "enrolled") continue
      const login = row.username.trim().toLowerCase()
      if (!login) continue
      if (hasStudentEnrollment(row)) studentSet.add(login)
      if (row.roles.some((role) => role !== "student")) staffSet.add(login)
    }
    return { studentLogins: studentSet, staffLogins: staffSet }
  }, [rows])

  const settled = !isLoading && !isUnknown
  return {
    studentLogins: settled ? studentLogins : undefined,
    staffLogins: settled ? staffLogins : undefined,
    isLoading,
    isError,
    isUnknown,
  }
}

export function unionLogins(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...a, ...b])
}

export default useFunnelRoster
