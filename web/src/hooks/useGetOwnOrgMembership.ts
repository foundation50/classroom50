import { useQuery } from "@tanstack/react-query"
import { getPendingOrgInvite } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { retryTransientGitHubError } from "@/github-core/errors"
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
    queryKey: githubKeys.ownOrgMembership(org),
    queryFn: () => getPendingOrgInvite(client, org ?? ""),
    staleTime: 10 * 60 * 1000,
    retry: retryTransientGitHubError,
    // A definitive result (active membership, or a 403/404 error) must survive a
    // fresh observer mounting. An ancestor gate (OrgLayout) toggles a
    // full-screen spinner on this query's `isLoading`, which unmounts the subtree
    // that ALSO reads this query; without this, the remount's fresh observer
    // refetches the errored query (retryOnMount default), flipping isLoading back
    // to true — a subscribe→refetch→spinner→unmount→remount loop that pinned a
    // non-member on an infinite spinner. Keep the cached error; the membership
    // error screen offers an explicit retry.
    retryOnMount: false,
    enabled: Boolean(org),
  })
}

export default useGetOwnOrgMembership
