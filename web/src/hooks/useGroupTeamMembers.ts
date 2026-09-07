import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  githubKeys,
  REPO_READ_CONCURRENCY,
  retryOnRateLimit,
  withGithubReadSlot,
} from "@/github-core/queries"
import { listTeamMembers } from "@/github-core/queries"
import type { GitHubUser } from "@/github-core/types"
import { mapWithConcurrency } from "@/util/concurrency"

// Live membership for a set of group teams: slug -> members, plus the union of
// member logins (lowercased). The team-mode analog of useGroupRepoMembers —
// member resolution comes from the GitHub Teams (the authoritative link), not
// repo collaborators. Bounded fan-out through the shared read slot so a class
// with many teams doesn't burst one request per team.
export function useGroupTeamMembers(
  org: string,
  teamSlugs: string[],
): {
  membersBySlug: Map<string, GitHubUser[]>
  logins: Set<string>
  isPending: boolean
} {
  const client = useGitHubClient()

  // Stable key over the slug set (sorted) so the batch only refires when the
  // set of teams changes, not on every render.
  const slugKey = teamSlugs.toSorted().join(",")
  const enabled = Boolean(org) && teamSlugs.length > 0

  const { data, isLoading } = useQuery({
    queryKey: [...githubKeys.all, "group-team-members", org, slugKey] as const,
    queryFn: async () => {
      const membersBySlug = new Map<string, GitHubUser[]>()
      await mapWithConcurrency(
        teamSlugs,
        REPO_READ_CONCURRENCY,
        async (slug) => {
          // Tolerate a single team's failure (deleted team, 429 after
          // retries): one bad team must not blank every other team's members.
          try {
            const members = await withGithubReadSlot(() =>
              retryOnRateLimit(() => listTeamMembers(client, org, slug)),
            )
            membersBySlug.set(slug, members)
          } catch {
            // Leave this team's members unknown; other teams still resolve.
          }
        },
      )
      return membersBySlug
    },
    staleTime: 60 * 1000,
    enabled,
  })

  const empty = useMemo(() => new Map<string, GitHubUser[]>(), [])
  const membersBySlug = data ?? empty
  const logins = useMemo(() => {
    const set = new Set<string>()
    for (const members of membersBySlug.values()) {
      for (const member of members) set.add(member.login.toLowerCase())
    }
    return set
  }, [membersBySlug])

  return {
    membersBySlug,
    logins,
    isPending: enabled && isLoading,
  }
}

export default useGroupTeamMembers
