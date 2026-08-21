import { createFileRoute, Outlet } from "@tanstack/react-router"
import { PermissionErrorBoundary } from "@/components/PermissionErrorBoundary"

export const Route = createFileRoute("/_authed/$org/$classroom")({
  component: ClassroomLayout,
})

// The effective classroom role is now resolved once at the `_authed` shell
// (ClassroomRoleProvider wraps the persistent sidebar + Outlet there), so this
// boundary only keeps the classroom-scoped permission error surface.
function ClassroomLayout() {
  return (
    <PermissionErrorBoundary>
      <Outlet />
    </PermissionErrorBoundary>
  )
}
