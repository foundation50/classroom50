import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { retryTransientGitHubError } from "@/github-core/errors"
import { findMyGroupTeam } from "@/domain/teams/groupTeams"

// The viewer's OWN group team for a team-mode assignment (self-scoped
// /user/teams read — works for a student who can see nothing else). `data` is
// null once settled with no team; keep isLoading/isError apart from that so a
// transient failure is never read as "not on a team".
export function useMyGroupTeam(
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  opts?: { enabled?: boolean },
) {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.myGroupTeam(
      org ?? "",
      classroom ?? "",
      assignment ?? "",
    ),
    queryFn: () =>
      findMyGroupTeam(client, org ?? "", classroom ?? "", assignment ?? ""),
    enabled: Boolean(org && classroom && assignment) && (opts?.enabled ?? true),
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })
}

export default useMyGroupTeam
