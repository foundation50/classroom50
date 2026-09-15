import { useMutation, useQueryClient } from "@tanstack/react-query"
import { deleteAssignmentWithConflictRetry } from "@/domain/assignments"
import type { DeleteAssignmentInput } from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { seedAssignments } from "@/github-core/queries"

// Delete an assignment from a classroom. The hook owns the assignments.json
// cache reconcile so it runs even when the caller unmounts on success (the
// submissions page navigates away as the row disappears). The committed file is
// SEEDED rather than refetched: GitHub's contents API can still serve the
// pre-delete body for a few seconds, which would resurrect the row (#1004).
export function useDeleteAssignment() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeleteAssignmentInput) =>
      deleteAssignmentWithConflictRetry(client, input),
    onSuccess: (result, { org, classroom }) => {
      seedAssignments(queryClient, org, classroom, result.assignments)
    },
  })
}

export default useDeleteAssignment
