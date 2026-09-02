import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { getTeamsFile } from "@/domain/teams/teamsFile"

// The <classroom>/teams.json snapshot (classroom50/teams/v1). Absent file
// reads as the empty skeleton, so `data` always has an assignments map once
// loaded. Config-repo read — staff only (a student's read 404s like any other
// private config read and surfaces as an error the caller ignores).
export function useTeamsSnapshot(
  org: string | undefined,
  classroom: string | undefined,
  opts?: { enabled?: boolean },
) {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.teamsFile(org ?? "", classroom ?? ""),
    queryFn: () =>
      getTeamsFile(client, { org: org ?? "", classroom: classroom ?? "" }),
    enabled: Boolean(org && classroom) && (opts?.enabled ?? true),
    staleTime: 60 * 1000,
  })
}

export default useTeamsSnapshot
