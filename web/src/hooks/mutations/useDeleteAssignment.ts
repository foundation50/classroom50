import { useMutation } from "@tanstack/react-query"
import { deleteAssignment } from "@/domain/assignments"
import type { DeleteAssignmentInput } from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Delete an assignment from a classroom. A thin write-boundary hook: the cache
// reconcile is the caller's job (the assignments list refetches via the
// onDeleteAssignment callback the call site passes to mutate), so the hook only
// binds the client and delegates. Lives here so the write op is discoverable in
// hooks/mutations/ rather than inline in a table row (see ./README.md).
export function useDeleteAssignment() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (input: DeleteAssignmentInput) =>
      deleteAssignment(client, input),
  })
}

export default useDeleteAssignment
