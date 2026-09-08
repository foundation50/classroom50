import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  createAssignment,
  type CreateAssignmentInput,
  type CreateAssignmentResult,
} from "@/domain/assignments"
import { invalidateAssignments } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"

// Create an assignment. The hook owns the assignments.json listing invalidate
// (unmount-safe — the new assignment must appear even if the creator navigates
// away) and the unmount-safe deploy-tracking `onWrite` follow-up. UI (toasts,
// navigate, inline error/warning banners) stays at the call site, including the
// templateGrantWarning branch, which decides whether to navigate — see
// ./README.md.
export function useCreateAssignment(
  org: string,
  classroom: string,
  onWrite?: (
    result: CreateAssignmentResult,
    input: CreateAssignmentInput,
  ) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  // Attempt the owner-only template read-grant unless the org role is a
  // confirmed non-owner (see useCanAttemptTemplateGrant).
  const canGrantTemplateAccess = useCanAttemptTemplateGrant()

  return useMutation<
    CreateAssignmentResult,
    GitHubAPIError,
    CreateAssignmentInput
  >({
    meta: { keepTabOpen: true },
    mutationFn: (input) =>
      createAssignment(client, { ...input, canGrantTemplateAccess }),
    onSuccess: (result, input) => {
      invalidateAssignments(queryClient, org, classroom)
      onWrite?.(result, input)
    },
  })
}

export default useCreateAssignment
