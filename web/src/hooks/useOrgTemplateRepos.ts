import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import {
  filterTemplateRepos,
  orgTemplateReposQuery,
} from "@/github-core/queries"

// The org's template repos, filtered by what the teacher typed.
export function useOrgTemplateRepos(args: {
  org: string | undefined
  query: string
  enabled: boolean
}) {
  const client = useOptionalGitHubClient()
  const query = useQuery(
    orgTemplateReposQuery(client!, { org: args.org, enabled: args.enabled }),
  )

  const all = query.data?.items
  const items = useMemo(
    () => filterTemplateRepos(all ?? [], args.query),
    [all, args.query],
  )

  const enabled = Boolean(client && args.org) && args.enabled

  return {
    items,
    // Templates found before the typed filter — the denominator for "3 of 48".
    totalCount: all?.length ?? 0,
    truncated: query.data?.truncated ?? false,
    scanned: query.data?.scanned ?? 0,
    templateFlagPresent: query.data?.templateFlagPresent ?? true,
    isError: query.isError,
    // isFetching, not isPending: a retry after a failure must read as loading
    // rather than leaving the failure copy on screen over an in-flight request.
    isLoadingList: enabled && query.isFetching,
  }
}

export default useOrgTemplateRepos
