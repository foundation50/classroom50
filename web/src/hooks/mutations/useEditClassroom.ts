import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  editClassroomWithConflictRetry,
  type EditClassroomInput,
  type EditClassroomResult,
} from "@/domain/classrooms"
import { githubKeys, seedJsonFile } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Save a classroom's settings. The hook owns the cache reconcile so a rename
// lands regardless of the editor navigating away: the classroom.json the detail
// read uses is seeded with the committed record (see seedJsonFile), while the
// classes listing is a different query and is invalidated. `onWrite`
// carries the unmount-safe deploy-tracking follow-up with its translated label.
// Toasts stay at the call site — see ./README.md.
export function useEditClassroom(
  org: string,
  classroom: string,
  onWrite?: (result: EditClassroomResult) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<EditClassroomResult, GitHubAPIError, EditClassroomInput>({
    meta: { keepTabOpen: true },
    mutationFn: (input) => editClassroomWithConflictRetry(client, input),
    onSuccess: (result) => {
      seedJsonFile(
        queryClient,
        githubKeys.classroomFile(org, classroom),
        result.classroom,
        result,
      )
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
      if (result.teamDescription.changed) {
        // The edit re-projected the classroom50/team/v1 record onto the student
        // team; refresh GET /user/teams so a teacher previewing as a student
        // sees the new name immediately.
        void queryClient.invalidateQueries({ queryKey: githubKeys.myTeams() })
      }
      onWrite?.(result)
    },
  })
}

export default useEditClassroom
