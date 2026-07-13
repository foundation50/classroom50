import {
  createFileRoute,
  Navigate,
  Outlet,
  useParams,
  useRouterState,
} from "@tanstack/react-router"

import { Spinner } from "@/components/Spinner"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { useOrgClassroom50Status } from "@/hooks/useOrgClassroom50Status"
import { OrgRoleProvider, useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

export const Route = createFileRoute("/_authed/$org")({
  component: OrgLayout,
})

// Gate /$org/* on the classroom50 config repo existing: an admin who hasn't
// initialized is sent to setup instead of landing on empty pages that 404 under
// the hood. Students/non-admins are never redirected — a 404 on the private
// config repo is expected for them, so gating would lock them out of their org.
function OrgLayout() {
  const { org } = useParams({ from: "/_authed/$org" })
  return (
    <OrgRoleProvider org={org}>
      <OrgLayoutInner />
    </OrgRoleProvider>
  )
}

function OrgLayoutInner() {
  const { org } = useParams({ from: "/_authed/$org" })
  // Match the setup route by matched-route id, not a pathname suffix: a suffix
  // check (endsWith("/setup")) both collides with any path segment named
  // "setup" (e.g. an assignment slug) and silently breaks if the route is ever
  // renamed — reintroducing the redirect loop this escape hatch prevents.
  const onSetupRoute = useRouterState({
    select: (s) => s.matches.some((m) => m.routeId === "/_authed/$org/setup/"),
  })

  const { isLoading: loadingMembership } = useGetOwnOrgMembership(org)
  // Gate on the org-role capability (provider mounted by OrgLayout) rather than
  // re-deriving the admin literal from membership.
  const { orgRole } = useOrgRole()
  const isAdmin = can("manageOrg", { orgRole })

  const { data: repoStatus, isLoading: loadingRepo } =
    useOrgClassroom50Status(org)

  // Setup is the redirect target, so keep it reachable or the guard loops.
  if (onSetupRoute) return <Outlet />

  if (loadingMembership || loadingRepo) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Spinner size="lg" />
      </div>
    )
  }

  // Fail open on every other shape (unconfirmed admin, "unknown" status): this
  // gate is UX, not the boundary — GitHub's 404/403 to the underlying reads is —
  // so degrade to the normal org page rather than trapping or misrouting anyone.
  if (isAdmin && repoStatus === "missing") {
    return <Navigate to="/$org/setup" params={{ org }} replace />
  }

  return <Outlet />
}
