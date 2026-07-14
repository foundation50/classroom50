import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

// The org-owner UX gate as a single tri-state, so every owner-gated surface
// reads the same fail-closed verdict instead of re-deriving `role === "admin"`.
// `isPending` holds (spinner) while the read is in flight; `isError` (retries
// exhausted, role still unresolved) drives a retryable surface via `retry`
// rather than stranding a real owner in an indefinite spinner. Backed by
// useOrgRole, so it fetches nothing itself and returns the safe `unresolved`
// default off the $org boundary.
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
