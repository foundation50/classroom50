import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { initClassroom50, type InitStepUpdate } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { orgClassroom50StatusKey } from "@/hooks/useOrgClassroom50Status"

type InitResult = Awaited<ReturnType<typeof initClassroom50>> | undefined

// Which surface is running setup. The two refresh different caches, and the
// first run refreshes even on a status-"error" outcome (matching its prior
// unconditional invalidate) while a re-run skips it on error.
export type RunOrgSetupMode = "first-run" | "rerun"

// Run (or re-run) org setup: the idempotent initClassroom50 that applies
// lockdown, rulesets, and repo settings. The hook owns the cache invalidation
// in its OWN onSuccess, NOT at the call site, because init runs ~10 sequential
// steps and the user can navigate away mid-run: a per-call mutate() onSuccess
// is dropped on unmount (react-query gates it on hasListeners()), which would
// silently skip the post-setup refetch. UI setState (step board,
// done/failed/next) stays at the call site's per-call onSuccess (correctly
// skipped on unmount).
export function useRunOrgSetup(params: {
  org: string | undefined
  plan?: string
  mode: RunOrgSetupMode
  onStepUpdate: (update: InitStepUpdate) => void
  confirmSkeletonOverwrite?: (paths: string[]) => Promise<boolean>
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, plan, mode, onStepUpdate, confirmSkeletonOverwrite } = params

  return useMutation({
    meta: { keepTabOpen: true },
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
    onSuccess: (result) => invalidateAfterSetup(queryClient, org, mode, result),
  })
}

function invalidateAfterSetup(
  queryClient: QueryClient,
  org: string | undefined,
  mode: RunOrgSetupMode,
  result: InitResult,
) {
  if (mode === "first-run") {
    // Also refetch the config-repo probe so the derived stage advances to 2.
    void queryClient.invalidateQueries({ queryKey: githubKeys.orgsPrefix() })
    void queryClient.invalidateQueries({
      queryKey: orgClassroom50StatusKey(org),
    })
    return
  }
  // Re-run: only on a non-error outcome (init resolves with status "error" on
  // a prerequisite failure).
  if (!org || (result && result.status === "error")) return
  void queryClient.invalidateQueries({
    queryKey: githubKeys.orgAuditPrefix(org),
  })
  // Re-run can flip the Actions policy (or intentionally leave a pause), so
  // refresh the kill-switch toggle's derived mode too.
  void queryClient.invalidateQueries({
    queryKey: githubKeys.orgActionsMode(org),
  })
  void queryClient.invalidateQueries({ queryKey: githubKeys.orgsPrefix() })
  // Setup applies the member-default lockdown, so refresh the shared org query
  // the teacher pre-flight warnings read (the `["orgs"]` key above is a
  // different, non-github-prefixed list).
  void queryClient.invalidateQueries({
    queryKey: githubKeys.orgDetails(org),
  })
}

export default useRunOrgSetup
