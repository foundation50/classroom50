import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  setAssignmentLockWithConflictRetry,
  type SetAssignmentLockInput,
  type SetAssignmentLockResult,
} from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

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
    mutationFn: (input) => setAssignmentLockWithConflictRetry(client, input),
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

export default useSetAssignmentLock
