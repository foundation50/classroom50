import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { initClassroom50, type InitStepUpdate } from "@/github-core/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"

type InitResult = Awaited<ReturnType<typeof initClassroom50>> | undefined

// Run (or re-run) org setup: the idempotent initClassroom50 that applies
// lockdown, rulesets, and repo settings. The hook owns the cache invalidation
// (via the caller-supplied `invalidate`) in its OWN onSuccess — NOT at the call
// site — because init runs ~10 sequential steps and the user can navigate away
// mid-run: a per-call mutate() onSuccess is dropped on unmount (react-query
// gates it on hasListeners()), which would silently skip the post-setup refetch.
// The hook-level onSuccess always runs. The two call sites invalidate different
// key sets, so `invalidate` is a callback rather than a fixed key list; it
// receives the result to branch on data.status. UI setState (step board,
// done/failed/next) stays at the call site's per-call onSuccess (correctly
// skipped on unmount). Callbacks bind at hook-call time (they close over page
// state); org/plan are stable per render.
export function useRunOrgSetup(params: {
  org: string | undefined
  plan?: string
  onStepUpdate: (update: InitStepUpdate) => void
  confirmSkeletonOverwrite?: (paths: string[]) => Promise<boolean>
  // Always-run cache reconcile (unmount-safe). Receives the init result so a
  // caller can invalidate only on a non-error outcome.
  invalidate: (queryClient: QueryClient, result: InitResult) => void
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, plan, onStepUpdate, confirmSkeletonOverwrite, invalidate } =
    params

  return useMutation({
    mutationFn: () => {
      // Resolve undefined when org is absent (callers branch on the result);
      // matches the pre-refactor early return.
      if (!org) return Promise.resolve(undefined)
      return initClassroom50({
        client,
        org,
        plan,
        onStepUpdate,
        confirmSkeletonOverwrite,
      })
    },
    onSuccess: (result) => invalidate(queryClient, result),
  })
}

export default useRunOrgSetup
