import { useQueries } from "@tanstack/react-query"
import { useMemo } from "react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoQuery } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

// Reads each org's `classroom50` config-repo `pushed_at` to drive the home
// page's "last modified" sort and the always-shown "Updated …" line on each
// card. Uses `repoQuery` so the result shares the
// `githubKeys.repo(login, "classroom50")` cache with other classroom50-repo
// readers instead of adding a bespoke per-org query. Maps login -> ISO
// timestamp, or undefined when pending / unreadable (e.g. no_access orgs,
// 404s) — the caller pins those to the bottom of the sort.
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

  // Build a login -> timestamp map with a stable reference across renders where
  // the resolved values haven't changed: callers use it as a useMemo dependency
  // (the home-page sort), so a fresh object every render would defeat their
  // memoization and re-sort on every keystroke. Key the memo on a signature of
  // the resolved pairs rather than the per-render `results`/`logins` arrays.
  const timestamps = results.map((r) => r.data?.pushed_at ?? undefined)
  const signature = logins
    .map((login, i) => `${login}=${timestamps[i]}`)
    .join("\n")
  return useMemo(() => {
    const byLogin: Record<string, string | undefined> = {}
    logins.forEach((login, i) => {
      byLogin[login] = timestamps[i]
    })
    return byLogin
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
}

export default useOrgLastModified
