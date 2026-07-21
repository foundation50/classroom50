import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/authz"

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

// Whether an assignment write should ATTEMPT the owner-only template read-grant.
// Distinct from `isOwner`: a not-yet-confirmed org role (in flight, or settled in
// a transient error) must NOT be treated as a confirmed non-owner, or a real
// owner deep-linking into the form before the org read settles skips the
// student-team grant and gets the misleading owner-required warning — students
// then 404 on accept. Attempt the grant unless the role is a CONFIRMED non-owner
// (member/non-member): the grant path never throws, so a non-owner's optimistic
// attempt fails soft into the same actionable warning, while a real owner's
// succeeds. The owner-required warning is reserved for the confirmed-non-owner
// case, where it is accurate.
export function useCanAttemptTemplateGrant(): boolean {
  const { githubOrgRole } = useGitHubOrgRole()
  const confirmedNonOwner =
    githubOrgRole === "member" || githubOrgRole === "non-member"
  return !confirmedNonOwner
}
