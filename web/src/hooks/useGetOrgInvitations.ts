import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import {
  githubKeys,
  getOrgInvitations,
  getOrgFailedInvitations,
} from "./github/queries"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

// Owner-only endpoints. Gate `enabled` on the manageOrg capability so a
// definitive non-owner never fires the guaranteed 403 and is treated as
// `isForbidden` without a request; `unresolved` holds until ownership is known.
// A transient 5xx/429 self-heals rather than silently rendering zero pending
// (the roster treats an empty invitations list as authoritative).
const useGetOrgInvitations = (org: string) => {
  const client = useGitHubClient()
  const { orgRole } = useOrgRole()
  const canManageOrg = can("manageOrg", { orgRole })

  const invitationsQuery = useQuery({
    queryKey: githubKeys.orgInvitations(org),
    queryFn: () => getOrgInvitations(client, org),
    enabled: Boolean(org) && canManageOrg,
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })

  const failedQuery = useQuery({
    queryKey: githubKeys.orgFailedInvitations(org),
    queryFn: () => getOrgFailedInvitations(client, org),
    enabled: Boolean(org) && canManageOrg,
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })

  // A definitive non-owner can't read invitations at all — report forbidden
  // without a request so the roster hides pending exactly as it did on a 403.
  const isForbidden =
    orgRole === "member" ||
    [invitationsQuery.error, failedQuery.error].some(
      (error) => error instanceof GitHubAPIError && error.isForbidden,
    )

  return {
    invitations: invitationsQuery.data ?? [],
    failedInvitations: failedQuery.data ?? [],
    isLoading: invitationsQuery.isLoading || failedQuery.isLoading,
    isError: invitationsQuery.isError || failedQuery.isError,
    isForbidden,
  }
}

export default useGetOrgInvitations
