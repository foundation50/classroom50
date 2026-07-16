import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  createClassroomFilesWithConflictRetry,
  type CreateClassroomInput,
  type CreateClassroomResult,
} from "@/domain/classrooms"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Create a classroom's config files. The hook owns the config-repo listing
// invalidate (unmount-safe — the new classroom must appear regardless of the
// creator navigating away) and, via `onWrite`, the deploy-tracking follow-up
// that also must survive unmount. UI (toasts, navigate, error logging) stays at
// the call site so it skips cleanly on unmount — see ./README.md. `onWrite`
// carries the translated activity label from the call site, keeping the hook
// t()-free.
export function useCreateClassroom(
  org: string,
  onWrite?: (
    result: CreateClassroomResult,
    input: CreateClassroomInput,
  ) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    CreateClassroomResult,
    GitHubAPIError,
    CreateClassroomInput
  >({
    mutationFn: (input) => createClassroomFilesWithConflictRetry(client, input),
    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
      onWrite?.(result, input)
    },
  })
}

export default useCreateClassroom
