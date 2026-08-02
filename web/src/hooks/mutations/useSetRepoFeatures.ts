import { useMutation } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { setRepoFeatures, type RepoFeaturePatch } from "@/github-core/mutations"

// Set a student repo's feature toggles (Issues/Wiki/Projects/Pull requests).
// Used by the bulk repo-features action to reconcile existing repos with an
// assignment's settings. No cache invalidation: repo feature flags aren't held
// in a query cache the gradebook reads.
export function useSetRepoFeatures() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (params: {
      org: string
      repo: string
      features: RepoFeaturePatch
    }) => setRepoFeatures({ client, ...params }),
  })
}

export default useSetRepoFeatures
