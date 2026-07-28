import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { openAllFeedbackPullRequests } from "@/domain/assignments"
import type {
  OpenAllFeedbackPrsSummary,
  OpenAllProgress,
} from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import type { AssignmentMode } from "@/types/classroom"

export type OpenAllFeedbackPrsInput = {
  org: string
  repos: string[]
  mode: AssignmentMode
}

// Bulk-open a Feedback PR on every assignment repo (issue #347). Wraps the
// domain fan-out and exposes live `progress` (a plain useState updated from the
// batch's onProgress) alongside the mutation, so a modal can render an "X of N"
// bar while it runs. Idempotent: a repo that already has a PR is counted, not
// duplicated.
//
// On completion we invalidate the open-pulls cache for the changed repos so any
// open Review lookups re-read. The Review button resolves on click (not on
// mount), so a broad prefix invalidation is cheap here — most entries aren't
// cached — and keeps the per-repo bookkeeping out of the hot path.
export function useOpenAllFeedbackPrs() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<OpenAllProgress | null>(null)

  const mutation = useMutation<
    OpenAllFeedbackPrsSummary,
    Error,
    OpenAllFeedbackPrsInput
  >({
    mutationFn: ({ org, repos, mode }) => {
      setProgress({ done: 0, total: repos.length })
      return openAllFeedbackPullRequests({
        client,
        org,
        repos,
        mode,
        onProgress: setProgress,
      })
    },
    onSuccess: (summary) => {
      if (summary.created > 0) {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.openPullsAll(),
        })
      }
    },
  })

  return {
    ...mutation,
    progress,
    // Clear progress + result when reopening the modal for a fresh run.
    reset: () => {
      setProgress(null)
      mutation.reset()
    },
  }
}

export default useOpenAllFeedbackPrs
