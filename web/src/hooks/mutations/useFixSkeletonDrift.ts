import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ensureSkeletonFiles } from "@/github-core/mutations"
import type { StaleSkeletonFile } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// The seed-vs-invalidate / success-vs-warning contract, shared by the hook and
// the banner: a fix is clean iff it completed with nothing skipped.
export function isFixResolvedClean(result: {
  status: string
  skippedOverwrite: string[]
}): boolean {
  return result.status === "complete" && result.skippedOverwrite.length === 0
}

// Refresh a config repo's drifted skeleton files, reconciling the drift cache in
// the hook's OWN onSuccess so it survives a mid-run unmount (per ./README.md).
// The non-obvious part: a clean fix SEEDS the cache empty rather than
// invalidating — a post-commit tree read is eventually consistent, so an
// invalidate could refetch the old drifted SHAs and re-flash the warning; a
// declined/partial fix still has drift, so it invalidates instead.
export function useFixSkeletonDrift(
  confirmOverwrite: (paths: string[]) => Promise<boolean>,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (targetOrg: string) =>
      ensureSkeletonFiles(client, targetOrg, confirmOverwrite),
    onSuccess: (result, targetOrg) => {
      const key = githubKeys.skeletonDrift(targetOrg)
      if (isFixResolvedClean(result)) {
        queryClient.setQueryData<StaleSkeletonFile[]>(key, [])
      } else {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export default useFixSkeletonDrift
