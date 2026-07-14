import { memo, useEffect } from "react"

import useStudentCount from "@/hooks/useStudentCount"

// Role-aware student counts for the classroom-list sort, collected without
// violating the Rules of Hooks. useStudentCount can't be called in a loop inside
// useClassroomSummaries because the classroom list grows/shrinks (create/delete)
// without remounting, which would change the hook count between renders. Instead
// each classroom gets a keyed probe component: React mounts/unmounts a whole
// component as the list changes, so each probe calls its hooks exactly once.
//
// Rendered only when the student-count sort is active (the caller gates it), so
// the team-membership fan-out doesn't happen otherwise. Probes render nothing.

const StudentCountProbe = memo(function StudentCountProbe({
  org,
  path,
  onCount,
}: {
  org: string
  path: string
  onCount: (path: string, count: number | undefined) => void
}) {
  const { studentCount, isError } = useStudentCount(org, path)
  useEffect(() => {
    // Report undefined on error so the sort pins the classroom to the unknown
    // bucket (bottom) rather than treating a failed read as an authoritative 0,
    // matching the card/header degradation (R6).
    onCount(path, isError ? undefined : studentCount)
  }, [path, studentCount, isError, onCount])
  return null
})

// Mounts one probe per classroom directory. onCount fires as each resolves.
export function StudentCountProbes({
  org,
  paths,
  onCount,
}: {
  org: string
  paths: string[]
  onCount: (path: string, count: number | undefined) => void
}) {
  return (
    <>
      {paths.map((path) => (
        <StudentCountProbe key={path} org={org} path={path} onCount={onCount} />
      ))}
    </>
  )
}
