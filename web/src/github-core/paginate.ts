import type { GitHubClient } from "./client"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_QUERIES)

// Walk a GitHub list endpoint to exhaustion, 100 items per page. `makePath`
// receives the 1-based page number. Stops when a page returns fewer than 100.
export async function paginateAll<T>(
  client: GitHubClient,
  makePath: (page: number) => string,
): Promise<T[]> {
  const all: T[] = []
  let page = 1
  // Hard cap (100 pages x 100/page = 10k items) so a server that ignores the
  // page param and keeps returning full pages can't loop unbounded.
  const MAX_PAGES = 100

  while (page <= MAX_PAGES) {
    const batch = await client.request<T[]>(makePath(page))
    all.push(...batch)
    if (batch.length < 100) break
    page++
  }

  if (page > MAX_PAGES) {
    log.warn("pagination hit MAX_PAGES cap, results may be truncated", {
      maxPages: MAX_PAGES,
    })
  }

  return all
}
