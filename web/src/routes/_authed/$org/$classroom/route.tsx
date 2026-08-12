import { createFileRoute, Outlet, useParams } from "@tanstack/react-router"
import { PermissionErrorBoundary } from "@/components/PermissionErrorBoundary"
// MIGRATION(v1.28): remove with the schema-migration banner component.
import { ClassroomMigrationBanner } from "@/components/ClassroomMigrationBanner"

export const Route = createFileRoute("/_authed/$org/$classroom")({
  component: ClassroomLayout,
})

// The effective classroom role is now resolved once at the `_authed` shell
// (ClassroomRoleProvider wraps the persistent sidebar + Outlet there), so this
// boundary only keeps the classroom-scoped permission error surface. The
// migration banner sits above the Outlet so it persists across every classroom
// subview until the teacher migrates assignments.json (it self-hides otherwise).
function ClassroomLayout() {
  const { org, classroom } = useParams({ strict: false })
  return (
    <PermissionErrorBoundary>
      {/* MIGRATION(v1.28): remove with the schema-migration banner. */}
      <ClassroomMigrationBanner org={org} classroom={classroom} />
      <Outlet />
    </PermissionErrorBoundary>
  )
}
