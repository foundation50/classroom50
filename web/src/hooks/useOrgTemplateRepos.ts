import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import {
  filterTemplateRepos,
  orgTemplateReposQuery,
} from "@/github-core/queries"

// The org's template repos, filtered by what the teacher typed.
//
// The list is fetched once per org and filtered in memory, so typing costs no
// requests at all — GitHub's search API is unusable from the browser (malformed
// CORS header, then a 502), and per-keystroke listing would be far worse.
export function useOrgTemplateRepos(args: {
  org: string | undefined
  query: string
  enabled: boolean
}) {
  const client = useOptionalGitHubClient()
  const enabled = Boolean(client && args.org) && args.enabled

  const query = useQuery({
    ...orgTemplateReposQuery(client!, { org: args.org, enabled }),
  })

  const all = query.data?.items
  const items = useMemo(
    () => filterTemplateRepos(all ?? [], args.query),
    [all, args.query],
  )

  return {
    ...query,
    items,
    // Total templates found, before the typed filter — the denominator for
    // "3 of 48".
    totalCount: all?.length ?? 0,
    truncated: query.data?.truncated ?? false,
    scanned: query.data?.scanned ?? 0,
    isLoadingList: enabled && query.isPending,
  }
}

export default useOrgTemplateRepos
