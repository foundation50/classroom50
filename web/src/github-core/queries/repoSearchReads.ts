import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubRepo } from "../types"
import { githubKeys } from "./keys"

// One page of the picker's list. Deliberately not `GitHubRepo`: the view needs
// six fields, and returning the full payload invites reads of properties the
// search endpoint doesn't reliably populate.
export type TemplateRepoSearchItem = {
  fullName: string
  name: string
  description?: string
  private: boolean
  updatedAt?: string
  htmlUrl?: string
}

export type TemplateRepoSearchResult = {
  items: TemplateRepoSearchItem[]
  // Total matches GitHub claims, which can far exceed `items` — the picker uses
  // it to tell the teacher to keep typing rather than implying it showed all.
  totalCount: number
  // GitHub timed out against its own index; the results are a partial answer.
  incomplete: boolean
}

type SearchRepositoriesResponse = {
  total_count?: number
  incomplete_results?: boolean
  items?: GitHubRepo[]
}

export const TEMPLATE_SEARCH_PER_PAGE = 30

// Search the org's template repos by name.
//
// This is the only listing path that scales: `GET /orgs/{org}/repos` would
// paginate the entire org (10k cap in paginateAll) and doesn't return
// `is_template` at all. `fork:true` is required because search excludes forks by
// default and a forked template is a legitimate case here.
//
// Note the cost model differs from every other read in this layer: search has
// its own 30-requests-per-minute bucket, is capped at 1000 results, and its
// errors must not be retried into that bucket. Callers own the debounce.
export async function searchOrgTemplateRepos(
  client: GitHubClient,
  args: { org: string; query: string; perPage?: number; signal?: AbortSignal },
): Promise<TemplateRepoSearchResult> {
  const terms = args.query.trim()
  const qualifiers = [`org:${args.org}`, "template:true", "fork:true"]
  // `in:name` keeps the match to the repo name; without it GitHub also searches
  // descriptions and READMEs, which buries the obvious match.
  const q = terms
    ? `${terms} in:name ${qualifiers.join(" ")}`
    : qualifiers.join(" ")

  const params = new URLSearchParams({
    q,
    per_page: String(args.perPage ?? TEMPLATE_SEARCH_PER_PAGE),
  })
  // With no search terms, relevance ranking has nothing to rank, so show the
  // org's most recently touched templates instead of an arbitrary slice.
  if (!terms) {
    params.set("sort", "updated")
    params.set("order", "desc")
  }

  const response = await client.request<SearchRepositoriesResponse>(
    `/search/repositories?${params.toString()}`,
    { method: "GET", signal: args.signal },
  )

  const items = (response.items ?? []).flatMap((repo) => {
    // Belt-and-braces on `template:true`: a GHES host that ignores the
    // qualifier would otherwise offer non-templates the teacher can't use.
    if (!repo.is_template) return []
    if (!repo.full_name) return []
    return [
      {
        fullName: repo.full_name,
        name: repo.name,
        description: repo.description ?? undefined,
        private: Boolean(repo.private),
        updatedAt: repo.updated_at ?? undefined,
        htmlUrl: repo.html_url ?? undefined,
      },
    ]
  })

  return {
    items,
    totalCount: response.total_count ?? items.length,
    incomplete: Boolean(response.incomplete_results),
  }
}

export function orgTemplateRepoSearchQuery(
  client: GitHubClient,
  args: { org: string | undefined; query: string; enabled?: boolean },
) {
  return queryOptions({
    queryKey: githubKeys.orgTemplateRepoSearch(args.org, args.query),
    queryFn: ({ signal }) =>
      searchOrgTemplateRepos(client, {
        org: args.org!,
        query: args.query,
        signal,
      }),
    enabled: Boolean(args.org) && (args.enabled ?? true),
    // Long enough that reopening the picker or retyping a prefix costs nothing,
    // which is what keeps a 30/min bucket comfortable.
    staleTime: 5 * 60 * 1000,
    // Never auto-retry into the search rate limit; the caller shows the throttle
    // and lets the teacher type the name instead.
    retry: false,
  })
}
