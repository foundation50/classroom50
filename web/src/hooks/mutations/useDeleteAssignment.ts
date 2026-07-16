import { useMutation } from "@tanstack/react-query"
import { deleteAssignment } from "@/domain/assignments"
import type { DeleteAssignmentInput } from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Delete an assignment from a classroom. Thin write-boundary passthrough: the
// assignments list refetches via the onDeleteAssignment callback the call site
// passes, so the hook only binds the client and delegates.
export function useDeleteAssignment() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (input: DeleteAssignmentInput) =>
      deleteAssignment(client, input),
  })
}

export default useDeleteAssignment
