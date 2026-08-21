import { useQuery } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { orgTemplateRepoSearchQuery } from "@/github-core/queries"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"

// Debounce chosen against the search endpoint's own 30-requests-per-minute
// bucket: long enough that a teacher typing a repo name spends one request, not
// one per keystroke.
const SEARCH_DEBOUNCE_MS = 400

// Search an org's template repos for the picker. Only runs while the picker is
// open — an idle assignment form must not spend the search budget.
export function useSearchOrgTemplateRepos(args: {
  org: string | undefined
  query: string
  enabled: boolean
}) {
  const client = useOptionalGitHubClient()
  const trimmed = args.query.trim()
  const debounced = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS)
  const enabled = Boolean(client && args.org) && args.enabled

  const query = useQuery({
    ...orgTemplateRepoSearchQuery(client!, {
      org: args.org,
      query: debounced,
      enabled,
    }),
    // Keep the previous page of results on screen while the next keystroke's
    // query resolves, so the list doesn't flash empty mid-type.
    placeholderData: (previous) => previous,
  })

  return {
    ...query,
    // True while the debounce is still draining as well as while the request is
    // in flight; without the first half the panel claims "no results" for the
    // 400ms before the search has even been sent.
    isSearching: enabled && (trimmed !== debounced || query.isFetching),
  }
}

export default useSearchOrgTemplateRepos
