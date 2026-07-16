import { useMutation } from "@tanstack/react-query"
import { initClassroom50, type InitStepUpdate } from "@/github-core/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Run (or re-run) org setup: the idempotent initClassroom50 that applies
// lockdown, rulesets, and repo settings. THIN — owns only the init call, no
// invalidation, because the two call sites (RerunOrgSetup, OrgSetupPage)
// invalidate differently and branch on data.status "error" into different
// component state. Each keeps its own onSuccess + step-reset wrapper; the hook's
// mutationFn just calls initClassroom50 (see ./README.md).
//
// Callbacks are bound at hook-call time (they close over the page's step state
// and modal); org/plan are stable per render.
export function useRunOrgSetup(params: {
  org: string | undefined
  plan?: string
  onStepUpdate: (update: InitStepUpdate) => void
  confirmSkeletonOverwrite?: (paths: string[]) => Promise<boolean>
}) {
  const client = useGitHubClient()
  const { org, plan, onStepUpdate, confirmSkeletonOverwrite } = params

  return useMutation({
    mutationFn: () => {
      if (!org) return Promise.resolve(undefined)
      return initClassroom50({
        client,
        org,
        plan,
        onStepUpdate,
        confirmSkeletonOverwrite,
      })
    },
  })
}

export default useRunOrgSetup
