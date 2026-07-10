import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import {
  githubKeys,
  getOrgInvitations,
  getOrgFailedInvitations,
} from "./github/queries"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"

// Owner-only endpoints; a non-owner token gets 403, surfaced as `isForbidden`
// so the UI can explain why invite status is hidden. 403/404 stay definitive
// (no retry) so isForbidden resolves at once; a transient 5xx/429 self-heals
// rather than silently rendering zero pending (the roster treats an empty
// invitations list as authoritative).
const useGetOrgInvitations = (org: string) => {
  const client = useGitHubClient()

  const invitationsQuery = useQuery({
    queryKey: githubKeys.orgInvitations(org),
    queryFn: () => getOrgInvitations(client, org),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })

  const failedQuery = useQuery({
    queryKey: githubKeys.orgFailedInvitations(org),
    queryFn: () => getOrgFailedInvitations(client, org),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })

  const isForbidden = [invitationsQuery.error, failedQuery.error].some(
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
