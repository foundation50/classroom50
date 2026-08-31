import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { listAssignmentGroupTeams } from "@/domain/teams/groupTeams"

// One team-mode assignment's group teams, from the org team listing (teacher
// view). A non-owner's listing degrades to [] inside the domain read.
export function useGroupTeams(
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  opts?: { enabled?: boolean },
) {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.groupTeams(
      org ?? "",
      classroom ?? "",
      assignment ?? "",
    ),
    queryFn: () =>
      listAssignmentGroupTeams(
        client,
        org ?? "",
        classroom ?? "",
        assignment ?? "",
      ),
    enabled: Boolean(org && classroom && assignment) && (opts?.enabled ?? true),
    staleTime: 60 * 1000,
  })
}

export default useGroupTeams
