import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  setAssignmentLockWithConflictRetry,
  type SetAssignmentLockInput,
  type SetAssignmentLockResult,
} from "@/domain/assignments"
import { seedAssignments } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Lock or unlock an assignment. The hook owns the assignments.json cache
// reconcile (unmount-safe — the badge/state must update even if the teacher
// navigates away): the committed file is SEEDED rather than refetched, since a
// refetch can race GitHub's eventual contents API and show the lock snapping
// back for 10 minutes (#1004). The domain function does the template
// grant/revoke itself, so no template-grant flag is threaded here. UI (toasts,
// the non-fatal templateAccessWarning banner) stays at the call site — see
// ./README.md.
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
      seedAssignments(queryClient, org, classroom, result.assignments)
      onWrite?.(result, input)
    },
  })
}

export default useSetAssignmentLock
