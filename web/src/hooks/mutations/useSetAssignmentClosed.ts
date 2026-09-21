import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  setAssignmentClosedWithConflictRetry,
  type SetAssignmentClosedInput,
  type SetAssignmentClosedResult,
} from "@/domain/assignments"
import { seedAssignments } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Close or reopen an assignment's submission window. The hook owns the
// assignments.json cache reconcile (unmount-safe — the status badge must update
// even if the teacher navigates away): the committed file is SEEDED rather than
// refetched, since a refetch can race GitHub's eventual contents API (#1004).
// Unlike useSetAssignmentLock this has no template-access side effect; the
// per-repo collaborator downgrade that "Close submission" performs lives in the
// calling modal.
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
      seedAssignments(queryClient, org, classroom, result.assignments)
      onWrite?.(result, input)
    },
  })
}

export default useSetAssignmentClosed
