import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoQuery } from "@/hooks/github/queries"

// Reads each org's `classroom50` config-repo `pushed_at` to drive the home
// page's "last modified" sort. Reuses `repoQuery` (same cache key as the
// ready-org existence read) so we don't fan out a second request per org or
// collide with githubKeys.repo. Only called with `enabled` true when the user
// actually selects the last-modified sort, keeping the default view
// fan-out-free. Maps login -> ISO timestamp, or undefined when pending /
// unreadable (e.g. no_access orgs, 404s) — the caller pins those to the bottom.
const useOrgLastModified = (
  logins: string[],
  enabled: boolean,
): Record<string, string | undefined> => {
  const client = useGitHubClient()

  const results = useQueries({
    queries: logins.map((login) => ({
      ...repoQuery(client, login, "classroom50"),
      enabled: enabled && Boolean(login),
    })),
  })

  const byLogin: Record<string, string | undefined> = {}
  logins.forEach((login, i) => {
    byLogin[login] = results[i]?.data?.pushed_at ?? undefined
  })

  return byLogin
}

export default useOrgLastModified
