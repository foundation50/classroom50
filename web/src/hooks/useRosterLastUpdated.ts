import { useQuery } from "@tanstack/react-query"

import { latestConfigFileCommitQuery } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { rosterPath } from "@/util/rosterPath"

// When roster.csv was last committed — the timestamp behind the roster
// toolbar's "Updated x ago" caption. Committer date (not author date) is the
// better "when did this land" proxy. Null while loading, on error, or when the
// roster has no commits yet.
export function useRosterLastUpdated(
  org: string,
  classroom: string,
): Date | null {
  const client = useGitHubClient()
  const { data } = useQuery(
    latestConfigFileCommitQuery(client, org, rosterPath(classroom)),
  )
  const iso = data?.commit.committer?.date ?? data?.commit.author?.date
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

export default useRosterLastUpdated
