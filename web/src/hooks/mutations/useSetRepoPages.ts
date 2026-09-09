import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import {
  enableRepoPages,
  type EnableRepoPagesResult,
  type PagesEnableReason,
} from "@/github-core/mutations"
import type { PagesCreateBody } from "@/util/repoPages"

// The refusal copy per classified reason, shared by the per-repo action and
// the bulk modal. Each value takes `{ repo }`.
export const PAGES_REFUSAL_KEYS: Record<PagesEnableReason, string> = {
  plan: "submissions.rowPages.refused.plan",
  policy: "submissions.rowPages.refused.policy",
  branch: "submissions.rowPages.refused.branch",
  access: "submissions.rowPages.refused.access",
  unknown: "submissions.rowPages.refused.unknown",
}

// Configure a student repo's GitHub Pages site after the fact (issue #919):
// the per-repo action and the bulk action for repos accepted before the
// assignment's Pages setting existed, or whose accept-time enable was refused.
// A refusal resolves (classified) rather than rejecting so callers show the
// specific reason; the caller decides what counts as a failure. Invalidates on
// settled the caches that carry the site: the org repo list (has_pages drives
// the row shortcut) and the per-repo Pages read (the hub's status row).
export function useSetRepoPages() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    EnableRepoPagesResult,
    Error,
    { org: string; repo: string; body: PagesCreateBody }
  >({
    mutationFn: ({ org, repo, body }) =>
      enableRepoPages(client, org, repo, body),
    onSettled: (_data, _error, { org, repo }) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgRepos(org),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.repo(org, repo),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.repoPages(org, repo),
      })
    },
  })
}

export default useSetRepoPages
