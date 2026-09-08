import { useMutation, useQueryClient } from "@tanstack/react-query"
import { deleteAssignment } from "@/domain/assignments"
import type { DeleteAssignmentInput } from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateAssignments } from "@/github-core/queries"

// Delete an assignment from a classroom. The hook owns the assignments.json
// listing invalidate so it runs even when the caller unmounts on success (the
// submissions page navigates away as the row disappears).
export function useDeleteAssignment() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeleteAssignmentInput) =>
      deleteAssignment(client, input),
    onSuccess: (_result, { org, classroom }) => {
      invalidateAssignments(queryClient, org, classroom)
    },
  })
}

export default useDeleteAssignment
