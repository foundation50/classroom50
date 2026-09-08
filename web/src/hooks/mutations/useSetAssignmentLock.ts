import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  setAssignmentLockWithConflictRetry,
  type SetAssignmentLockInput,
  type SetAssignmentLockResult,
} from "@/domain/assignments"
import { invalidateAssignments } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Lock or unlock an assignment. The hook owns the assignments.json listing
// invalidate (unmount-safe — the badge/state must update even if the teacher
// navigates away). The domain function does the template grant/revoke itself,
// so no template-grant flag is threaded here. UI (toasts, the non-fatal
// templateAccessWarning banner) stays at the call site — see ./README.md.
export function useSetAssignmentLock(
  org: string,
  classroom: string,
  onWrite?: (
    result: SetAssignmentLockResult,
    input: SetAssignmentLockInput,
  ) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    SetAssignmentLockResult,
    GitHubAPIError,
    SetAssignmentLockInput
  >({
    meta: { keepTabOpen: true },
    mutationFn: (input) => setAssignmentLockWithConflictRetry(client, input),
    onSuccess: (result, input) => {
      invalidateAssignments(queryClient, org, classroom)
      onWrite?.(result, input)
    },
  })
}

export default useSetAssignmentLock
