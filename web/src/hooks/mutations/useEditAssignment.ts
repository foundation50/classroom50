import { useMutation } from "@tanstack/react-query"
import {
  editAssignmentWithConflictRetry,
  type CreateAssignmentInput,
  type CreateAssignmentResult,
} from "@/domain/assignments"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"

// Save an assignment's settings. This edit path historically does NOT invalidate
// the assignments cache (the page relies on its own refetch/staleTime), so the
// hook preserves that and owns only the unmount-safe deploy-tracking `onWrite`
// follow-up (its translated label comes from the call site, keeping the hook
// t()-free). `onMutate` is hook-level (React Query forbids it as a call-site
// option) so the caller's pre-flight banner reset runs before the write. UI
// (success/warning banners, scroll) stays at the call site — see ./README.md.
export function useEditAssignment(opts?: {
  onWrite?: (
    result: CreateAssignmentResult,
    input: CreateAssignmentInput,
  ) => void
  onMutate?: () => void
}) {
  const { onWrite, onMutate } = opts ?? {}
  const client = useGitHubClient()
  // Attempt the owner-only template read-grant unless the org role is a
  // confirmed non-owner (see useCanAttemptTemplateGrant).
  const canGrantTemplateAccess = useCanAttemptTemplateGrant()

  return useMutation<
    CreateAssignmentResult,
    GitHubAPIError,
    CreateAssignmentInput
  >({
    mutationFn: (input) =>
      editAssignmentWithConflictRetry(client, {
        ...input,
        canGrantTemplateAccess,
      }),
    onMutate,
    onSuccess: (result, input) => {
      onWrite?.(result, input)
    },
  })
}

export default useEditAssignment
