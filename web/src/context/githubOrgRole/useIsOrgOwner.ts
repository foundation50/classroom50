import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/util/capabilities"

// One shared org-owner UX verdict over useGitHubOrgRole, so owner-gated surfaces
// read a single fail-closed answer instead of re-deriving `role === "admin"`.
// Safe to call behind a RequireOwner route gate — such consumers can ignore
// isPending/isError (the gate holds/errors before they render).
export function useIsOrgOwner(): {
  isOwner: boolean
  isPending: boolean
  isError: boolean
  retry: () => void
} {
  const { githubOrgRole, isError, retry } = useGitHubOrgRole()
  return {
    isOwner: can("manageOrg", { githubOrgRole }),
    isPending: githubOrgRole === "unresolved" && !isError,
    isError,
    retry,
  }
}
