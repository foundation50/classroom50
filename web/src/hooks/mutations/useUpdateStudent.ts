import { useMutation } from "@tanstack/react-query"
import { updateStudentWithConflictRetry } from "@/domain/students"
import type { UpdateStudentInput } from "@/domain/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Update (or upsert) one student's roster row, conflict-retried. Thin
// write-boundary passthrough: the edit form owns the form->input shaping, the
// onSaved handoff, and error UI, so the hook delegates the per-call input.
export function useUpdateStudent() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (input: UpdateStudentInput) =>
      updateStudentWithConflictRetry(client, input),
  })
}

export default useUpdateStudent
