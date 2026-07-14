import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

// One shared org-owner UX verdict over useOrgRole, so owner-gated surfaces read
// a single fail-closed answer instead of re-deriving `role === "admin"`. Safe to
// call behind a RequireOwner route gate — such consumers can ignore
// isPending/isError (the gate holds/errors before they render).
export function useIsOrgOwner(): {
  isOwner: boolean
  isPending: boolean
  isError: boolean
  retry: () => void
} {
  const { orgRole, isError, retry } = useOrgRole()
  return {
    isOwner: can("manageOrg", { orgRole }),
    isPending: orgRole === "unresolved" && !isError,
    isError,
    retry,
  }
}
