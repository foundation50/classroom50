import { useMutation } from "@tanstack/react-query"
import { unenrollStudent } from "@/domain/students"
import type { UnenrollStudentInput } from "@/domain/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Unenroll one student from a classroom. Thin write-boundary hook: the roster
// modal owns the cache reconcile + toasts around the call, so the hook binds
// org/classroom and delegates the per-call `student`. Lives in hooks/mutations/
// so the write op is discoverable rather than inline in the modal.
export function useUnenrollStudent(org: string, classroom: string) {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: (student: UnenrollStudentInput["student"]) =>
      unenrollStudent(client, { org, classroom, student }),
  })
}

export default useUnenrollStudent
