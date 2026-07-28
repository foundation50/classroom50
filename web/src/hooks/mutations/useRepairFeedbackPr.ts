import { useMutation, useQueryClient } from "@tanstack/react-query"

import { repairFeedbackPullRequest } from "@/domain/assignments"
import type { RepairFeedbackPrResult } from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import type { AssignmentMode } from "@/types/classroom"

export type RepairFeedbackPrInput = {
  org: string
  repo: string
  mode: AssignmentMode
}

// Teacher-side repair for a missing Feedback PR (issue #347): re-run the same
// idempotent ensureFeedbackPullRequest as accept, with the teacher's token,
// when a student's accept-time attempt failed (GitHub outage / transient) or
// the repo predates the feature. The domain function never throws — it returns
// {ok:false} (retryable) or {unsupported:true} (no baseline) — so the call
// site maps the reason to copy. On a created PR we invalidate the row's
// openPulls read so useGetFeedbackPr picks it up regardless of the modal's
// fate (per ./README.md: cache consistency lives in the hook).
export function useRepairFeedbackPr() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<RepairFeedbackPrResult, Error, RepairFeedbackPrInput>({
    mutationFn: ({ org, repo, mode }) =>
      repairFeedbackPullRequest({ client, org, repo, mode }),
    onSuccess: (result, { org, repo }) => {
      if (result.ok && result.created) {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.openPulls(org, repo),
        })
      }
    },
  })
}

export default useRepairFeedbackPr
