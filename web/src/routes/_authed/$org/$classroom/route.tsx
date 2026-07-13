import { createFileRoute, Outlet, useParams } from "@tanstack/react-router"
import { ClassroomRoleProvider } from "@/context/classroomRole/ClassroomRoleProvider"
import { PermissionErrorBoundary } from "@/components/PermissionErrorBoundary"

export const Route = createFileRoute("/_authed/$org/$classroom")({
  component: ClassroomLayout,
})

// Classroom boundary: resolve the effective classroom role ONCE and share it
// with every child page + guard via context, so child surfaces read the role
// from context rather than each re-running resolution.
function ClassroomLayout() {
  const { org, classroom } = useParams({ from: "/_authed/$org/$classroom" })
  return (
    <PermissionErrorBoundary>
      <ClassroomRoleProvider org={org} classroom={classroom}>
        <Outlet />
      </ClassroomRoleProvider>
    </PermissionErrorBoundary>
  )
}
