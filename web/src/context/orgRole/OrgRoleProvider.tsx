import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { resolveOrgRole, type OrgRole } from "@/util/resolveRole"

// Org-wide capability, resolved ONCE at the $org boundary and shared with org-
// level routes (settings, members, activity, create-classroom) that have no
// classroom in scope. `owner` = active org admin; `member` = definitive
// non-admin; `unresolved` = a transient read (fail-closed — never demote a real
// owner on a blip). The finer classroom role layers on top of this at the
// classroom boundary (see ClassroomRoleProvider).
type OrgRoleContextValue = {
  orgRole: OrgRole
}

const OrgRoleContext = createContext<OrgRoleContextValue | null>(null)

// Provider mounted at $org/route.tsx. Reuses the org-membership read the layout
// already performs (React Query dedupes the shared key), so no extra fetch is
// introduced.
export function OrgRoleProvider({
  org,
  children,
}: PropsWithChildren<{ org: string | undefined }>) {
  const membership = useGetOwnOrgMembership(org)

  const orgRole = resolveOrgRole({
    isSuccess: membership.isSuccess,
    role: membership.data?.role,
    state: membership.data?.state,
    error: membership.error,
  })

  const value = useMemo(() => ({ orgRole }), [orgRole])

  return (
    <OrgRoleContext.Provider value={value}>{children}</OrgRoleContext.Provider>
  )
}

// Read the org-wide role. Returns `unresolved` off-route (no provider mounted),
// so org-level guards never null-check — and a missing provider fails closed
// (holds rather than grants) rather than throwing. Mirrors useRoleView's safe
// default.
export function useOrgRole(): OrgRoleContextValue {
  return useContext(OrgRoleContext) ?? { orgRole: "unresolved" }
}
