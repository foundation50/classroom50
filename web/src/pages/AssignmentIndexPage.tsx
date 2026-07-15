import { Navigate, useParams } from "@tanstack/react-router"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/util/capabilities"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"

// The bare assignment route has no view of its own: it forwards to the
// role-appropriate landing (teachers → submissions gradebook, students → their
// own submission). Wait for the role to resolve so we never bounce a teacher
// through the student page (or vice versa).
const AssignmentIndexPage = () => {
  const { org, classroom, assignment } = useParams({ strict: false })
  const { role, roleResolved } = useClassroomRoleContext()

  if (!org || !classroom || !assignment) {
    return <Navigate to="/" />
  }

  if (!roleResolved) {
    return <RoleResolvingFallback className="min-h-screen" />
  }

  return (
    <Navigate
      to={
        can("viewClassroomStaffContent", { classroomRole: role })
          ? "/$org/$classroom/assignments/$assignment/submissions"
          : "/$org/$classroom/assignments/$assignment/submission"
      }
      params={{ org, classroom, assignment }}
      replace
    />
  )
}

export default AssignmentIndexPage
