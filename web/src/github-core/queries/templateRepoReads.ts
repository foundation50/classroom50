import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubRepo } from "../types"
import { githubKeys } from "./keys"
import { retryOnRateLimit } from "./shared"
import { retryTransientGitHubError } from "../errors"

// One row in the template picker. Deliberately not `GitHubRepo`: the view needs
// five fields, and the org-listing payload doesn't reliably populate the rest.
export type TemplateRepoItem = {
  fullName: string
  name: string
  description?: string
  private: boolean
  updatedAt?: string
}

export type TemplateRepoListResult = {
  items: TemplateRepoItem[]
  // Repos actually examined. With `truncated` this is what lets the picker say
  // "searched the 1000 most recently updated repos" instead of implying it saw
  // the whole org.
  scanned: number
  truncated: boolean
  // False when no repo in the payload carried `is_template` at all, meaning the
  // host didn't tell us which repos are templates and `items` is unfiltered.
  templateFlagPresent: boolean
}

const PER_PAGE = 100

// Page budget, not a repo budget. GitHub's search API is unusable from the
// browser (it serves a malformed `Access-Control-Allow-Origin: *;` and then
// 502s), so listing is the only path — but an org can hold tens of thousands of
// repos, and walking all of it would be hundreds of sequential requests before
// the picker could render.
export const TEMPLATE_LIST_MAX_PAGES = 10

// Stop early once the panel has more templates than it can show. In a busy org
// the recency-sorted pages are mostly student assignment repos, so paging until
// the budget runs out is the common case; stopping at a satisfying yield is what
// keeps a template-rich org cheap without starving a template-poor one.
const ENOUGH_TEMPLATES = 60

// List the org's template repositories, most recently updated first.
//
// Filtering happens here rather than server-side because no list endpoint takes
// a template qualifier; the caller filters by name locally, which makes typing
// instant and costs no requests.
export async function listOrgTemplateRepos(
  client: GitHubClient,
  args: { org: string; maxPages?: number; signal?: AbortSignal },
): Promise<TemplateRepoListResult> {
  const maxPages = args.maxPages ?? TEMPLATE_LIST_MAX_PAGES
  const org = encodeURIComponent(args.org)
  const candidates: GitHubRepo[] = []
  let scanned = 0
  let templateFlagPresent = false
  let page = 1
  let truncated = false

  while (page <= maxPages) {
    let batch: GitHubRepo[]
    try {
      batch = await retryOnRateLimit(() =>
        client.request<GitHubRepo[]>(
          `/orgs/${org}/repos?per_page=${PER_PAGE}&page=${page}&type=all&sort=updated&direction=desc`,
          { method: "GET", signal: args.signal },
        ),
      )
    } catch (err) {
      // Keep what we already have rather than turning a late failure into an
      // empty picker; a first-page failure still surfaces as an error, since
      // there is nothing to show.
      if (scanned === 0) throw err
      truncated = true
      break
    }

    scanned += batch.length
    // `is_template` is in the documented list-response schema, but it has
    // historically been omitted on some hosts. Distinguish "no templates here"
    // from "this host won't tell us": in the latter case, offering every repo
    // unfiltered beats an empty picker the teacher can't explain.
    if (batch.some((repo) => repo.is_template !== undefined)) {
      templateFlagPresent = true
    }
    candidates.push(...batch)

    // A short page is the end of the org — nothing was skipped.
    if (batch.length < PER_PAGE) break
    if (page === maxPages) {
      // A full last page means there is more we chose not to fetch.
      truncated = true
      break
    }
    if (
      templateFlagPresent &&
      candidates.filter((repo) => repo.is_template === true).length >=
        ENOUGH_TEMPLATES
    ) {
      truncated = true
      break
    }
    page++
  }

  const templates = templateFlagPresent
    ? candidates.filter((repo) => repo.is_template === true)
    : candidates

  return {
    items: templates.map((repo) => ({
      fullName: repo.full_name,
      name: repo.name,
      description: repo.description ?? undefined,
      private: Boolean(repo.private),
      updatedAt: repo.updated_at ?? undefined,
    })),
    scanned,
    truncated,
    templateFlagPresent,
  }
}

export function orgTemplateReposQuery(
  client: GitHubClient,
  args: { org: string | undefined; enabled?: boolean },
) {
  return queryOptions({
    queryKey: githubKeys.orgTemplateRepos(args.org),
    queryFn: ({ signal }) =>
      listOrgTemplateRepos(client, { org: args.org!, signal }),
    enabled: Boolean(args.org) && (args.enabled ?? true),
    // Long enough that reopening the picker or retyping a prefix costs nothing.
    staleTime: 10 * 60 * 1000,
    // A throttled page is already retried inside the walk (retryOnRateLimit);
    // this covers a transient 5xx the same way every other read in the app does.
    retry: retryTransientGitHubError,
  })
}

// Filter the cached list by what the teacher typed. Local and synchronous — the
// whole reason the list is fetched once instead of per keystroke.
//
// Matches on the bare name and on `owner/repo`, so both "starter" and
// "cs50/star" narrow as expected. A name-position match sorts ahead of a later
// one, which puts the obvious candidate first.
export function filterTemplateRepos(
  items: TemplateRepoItem[],
  query: string,
  limit = 30,
): TemplateRepoItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items.slice(0, limit)

  return items
    .flatMap((item) => {
      const rank = Math.min(
        indexOrInfinity(item.name.toLowerCase(), needle),
        indexOrInfinity(item.fullName.toLowerCase(), needle),
      )
      return rank === Infinity ? [] : [{ item, rank }]
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ item }) => item)
}

function indexOrInfinity(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle)
  return index === -1 ? Infinity : index
}
