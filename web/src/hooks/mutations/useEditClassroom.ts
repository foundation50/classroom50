import { useMutation, useQueryClient } from "@tanstack/react-query"
import { editClassroomWithConflictRetry } from "@/domain/classrooms"
import {
  type EditClassroomInput,
  type EditClassroomResult,
} from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Save a classroom's settings. The hook owns both invalidates (the exact
// classroom.json the detail read uses, plus the classes listing) so a rename
// lands regardless of the editor navigating away; `onWrite` carries the
// unmount-safe deploy-tracking follow-up with its translated label. Toasts stay
// at the call site — see ./README.md.
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
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${classroom}/classroom.json`,
        ),
      })
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
