import type { GitHubRepo } from "@/github-core/types"

// Newest repo first, GitHub's own default for a repo listing. The org listing
// is walked oldest-first so pages stay stable while they are fetched in
// parallel, so a view that shows the list to a person sorts it back. Repos
// without a timestamp keep their relative order at the end.
export function sortReposNewestFirst<T extends Pick<GitHubRepo, "created_at">>(
  repos: readonly T[],
): T[] {
  return [...repos].sort((a, b) => {
    if (!a.created_at || !b.created_at) {
      return Number(!a.created_at) - Number(!b.created_at)
    }
    return b.created_at.localeCompare(a.created_at)
  })
}
