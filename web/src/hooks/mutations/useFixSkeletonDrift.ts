import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ensureSkeletonFiles } from "@/github-core/mutations"
import type { StaleSkeletonFile } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// A fix resolved clean iff it completed with nothing skipped; a declined
// overwrite (skippedOverwrite non-empty) leaves files drifted. Pure and shared:
// the hook uses it to pick seed-vs-invalidate, the banner uses it to pick the
// success-vs-warning view — one contract, one source.
export function isFixResolvedClean(result: {
  status: string
  skippedOverwrite: string[]
}): boolean {
  return result.status === "complete" && result.skippedOverwrite.length === 0
}

// Refresh a config repo's drifted skeleton files (scaffolded workflows that fell
// behind the bundled skeleton). `targetOrg` is the mutate variable — the banner
// is a singleton across orgs, so the result must be attributed to the org the
// fix ran against, not a live param that can change mid-run.
//
// The hook owns the drift-cache reconcile in its OWN onSuccess (unmount-safe):
// a clean fix seeds the cache empty rather than invalidating, because a
// post-commit tree read is eventually consistent and an invalidate could refetch
// the old (drifted) SHAs and re-flash the warning; a declined/partial fix
// (skippedOverwrite non-empty) leaves drift, so it invalidates instead. The
// banner's per-org UI state (fixed-clean, pending) stays at the call site — see
// ./README.md and the U9-batch-3 unmount-safety finding.
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
