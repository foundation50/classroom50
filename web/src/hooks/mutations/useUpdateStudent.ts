import { useMutation } from "@tanstack/react-query"
import { updateStudentWithConflictRetry } from "@/domain/students"
import type { UpdateStudentInput } from "@/domain/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Update (or upsert) one student's roster row, conflict-retried. Thin
// write-boundary hook: the edit form owns the form->input shaping, the result
// handoff (onSaved), and error UI, so the hook binds the client and delegates
// the per-call UpdateStudentInput. Lives in hooks/mutations/ so the write op is
// discoverable rather than inline in the form.
export function useUpdateStudent() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (input: UpdateStudentInput) =>
      updateStudentWithConflictRetry(client, input),
  })
}

export default useUpdateStudent
