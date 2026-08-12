import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  migrateClassroomAssignmentsWithConflictRetry,
  type MigrateClassroomAssignmentsInput,
  type MigrateClassroomAssignmentsResult,
} from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// MIGRATION(v1.28): schema-migration hook for one-time normalization of
// pre-1.28 assignments.json files. Safe to remove in a future version once no
// legacy files remain. Greppable tag: MIGRATION(v1.28).
// Migrate a classroom's assignments.json to the new submission-tracking
// semantics (write an explicit submission_mode + grading:auto onto every legacy
// entry, opting the detection overlay in without changing behavior). The hook
// owns the assignments.json listing invalidate (unmount-safe — the migrate
// banner must clear even if the teacher navigates away). A content
// normalization within v1, so there is no schema-version side effect.
export function useMigrateClassroomAssignments(
  org: string,
  classroom: string,
  onWrite?: (
    result: MigrateClassroomAssignmentsResult,
    input: MigrateClassroomAssignmentsInput,
  ) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    MigrateClassroomAssignmentsResult,
    GitHubAPIError,
    MigrateClassroomAssignmentsInput
  >({
    mutationFn: (input) =>
      migrateClassroomAssignmentsWithConflictRetry(client, input),
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

export default useMigrateClassroomAssignments
