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
// requests at all.
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
    // Total templates found, before the typed filter.
    totalCount: all?.length ?? 0,
    truncated: query.data?.truncated ?? false,
    scanned: query.data?.scanned ?? 0,
    // False only when the host never reported `is_template`, so `items` is every
    // org repo rather than a template list.
    templateFlagPresent: query.data?.templateFlagPresent ?? true,
    // isFetching, not isPending: a retry after a failure must read as loading
    // rather than leaving the failure copy on screen over an in-flight request.
    isLoadingList: enabled && query.isFetching,
  }
}

export default useOrgTemplateRepos
