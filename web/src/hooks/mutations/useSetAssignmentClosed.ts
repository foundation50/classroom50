import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  setAssignmentClosedWithConflictRetry,
  type SetAssignmentClosedInput,
  type SetAssignmentClosedResult,
} from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Close or reopen an assignment's submission window. The hook owns the
// assignments.json listing invalidate (unmount-safe — the status badge must
// update even if the teacher navigates away). Unlike useSetAssignmentLock this
// has no template-access side effect; the per-repo collaborator downgrade that
// "Close submission" performs lives in the calling modal.
export function useSetAssignmentClosed(
  org: string,
  classroom: string,
  onWrite?: (
    result: SetAssignmentClosedResult,
    input: SetAssignmentClosedInput,
  ) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    SetAssignmentClosedResult,
    GitHubAPIError,
    SetAssignmentClosedInput
  >({
    mutationFn: (input) => setAssignmentClosedWithConflictRetry(client, input),
    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${classroom}/assignments.json`,
        ),
      })
      onWrite?.(result, input)
    },
  })
}

export default useSetAssignmentClosed
