import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { renameAssignment } from "@/domain/assignments"
import type {
  RenameAssignmentInput,
  RenameAssignmentSummary,
  RenameProgress,
} from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

// One-shot assignment slug rename (#691): config commit, then the per-repo
// fan-out. Wraps the domain orchestration and exposes live `progress` (a plain
// useState updated from the fan-out's onProgress) so the modal can render an
// "X of N" bar while it runs — the useOpenAllFeedbackPrs shape. The modal is
// mounted per open, so no reset wrapper is needed.
//
// Invalidation runs on SETTLED, not just success: the config commit lands
// before the fan-out, so even a thrown preflight/commit race may leave the
// manifest renamed — the assignments list, the re-keyed scores, and the org
// repo list (renamed repos) must all re-read either way. The keys derive from
// the mutation variables so they can't drift from what was actually renamed.
export function useRenameAssignment() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<RenameProgress | null>(null)

  const mutation = useMutation<
    RenameAssignmentSummary,
    Error,
    RenameAssignmentInput
  >({
    meta: { keepTabOpen: true },
    mutationFn: (input) => {
      setProgress(null)
      return renameAssignment(client, input, { onProgress: setProgress })
    },
    onSettled: (_data, _error, { org, classroom }) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${classroom}/assignments.json`,
        ),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${classroom}/scores.json`,
        ),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgRepos(org),
      })
    },
  })

  return { ...mutation, progress }
}

export default useRenameAssignment
