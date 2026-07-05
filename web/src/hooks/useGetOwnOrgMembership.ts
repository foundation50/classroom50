import { useQuery } from "@tanstack/react-query"
import { getPendingOrgInvite } from "./github/mutations"
import { retryTransientGitHubError } from "./github/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Reads the authenticated user's OWN membership in `org` (GET
// /user/memberships/orgs/{org}). A definitive 404 (no membership) or 403
// (blocked / SAML SSO gated) does NOT retry — callers inspect the error to tell
// "not a member" (404) from "SSO/authorization" (403, see
// GitHubAPIError.isSsoRequired); a transient 5xx/429/network blip self-heals.
// The query is allowed to error (not swallowed to `undefined`) so the
// accept/onboarding gate can render a cause-specific screen.
const useGetOwnOrgMembership = (org: string | undefined) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: ["github", "memberships", "orgs", org],
    queryFn: () => getPendingOrgInvite(client, org ?? ""),
    staleTime: 10 * 60 * 1000,
    retry: retryTransientGitHubError,
    enabled: Boolean(org),
  })
}

export default useGetOwnOrgMembership
