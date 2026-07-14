import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoQuery } from "@/hooks/github/queries"
import { CONFIG_REPO } from "@/util/configRepo"

// Reads each org's `classroom50` config-repo `pushed_at` to drive the home
// page's "last modified" sort. Uses `repoQuery` so the result shares the
// `githubKeys.repo(login, "classroom50")` cache with other classroom50-repo
// readers instead of adding a bespoke per-org query. Only called with `enabled`
// true when the user actually selects the last-modified sort, keeping the
// default view fan-out-free. Maps login -> ISO timestamp, or undefined when
// pending / unreadable (e.g. no_access orgs, 404s) — the caller pins those to
// the bottom.
const useOrgLastModified = (
  logins: string[],
  enabled: boolean,
): Record<string, string | undefined> => {
  const client = useGitHubClient()

  const results = useQueries({
    queries: logins.map((login) => ({
      ...repoQuery(client, login, CONFIG_REPO),
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
