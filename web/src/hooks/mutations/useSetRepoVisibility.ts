import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { setRepoVisibility } from "@/github-core/mutations"
import type { RepoVisibility } from "@/types/classroom"

// Flip a student repo between private and public (issue #766). Used by the
// per-repo visibility toggle and the bulk visibility action. Invalidates on
// settled — the PATCH may have landed even when the response errored — both
// caches that carry the flag: the org repo list (the submissions page derives
// its Public badge from it) and the single-repo read (the manage hub's
// visibility row and toggle direction).
export function useSetRepoVisibility() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: {
      org: string
      repo: string
      visibility: RepoVisibility
    }) => setRepoVisibility({ client, ...params }),
    onSettled: (_data, _error, { org, repo }) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgRepos(org),
      })
      // useGetRepo's ad-hoc key.
      void queryClient.invalidateQueries({
        queryKey: ["github", "repo", org, repo],
      })
    },
  })
}

export default useSetRepoVisibility
