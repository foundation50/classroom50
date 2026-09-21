import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  editAssignmentWithConflictRetry,
  type CreateAssignmentInput,
  type CreateAssignmentResult,
} from "@/domain/assignments"
import { seedAssignments } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"

// Save an assignment's settings. The hook owns the assignments.json cache
// reconcile (unmount-safe — the persistent app shell no longer remounts the
// page, so a stale cache would otherwise linger until a hard refresh): the
// committed file is SEEDED rather than refetched, since GitHub's contents API
// can still serve the pre-write body for a few seconds (#1004). Also owns the
// unmount-safe deploy-tracking `onWrite` follow-up (its translated label comes
// from the call site, keeping the hook t()-free). `onMutate` is hook-level
// (React Query forbids it as a call-site option) so the caller's pre-flight
// banner reset runs before the write. UI (success/warning banners, scroll)
// stays at the call site — see ./README.md.
export function useEditAssignment(opts?: {
  onWrite?: (
    result: CreateAssignmentResult,
    input: CreateAssignmentInput,
  ) => void
  onMutate?: () => void
}) {
  const { onWrite, onMutate } = opts ?? {}
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
      editAssignmentWithConflictRetry(client, {
        ...input,
        canGrantTemplateAccess,
      }),
    onMutate,
    onSuccess: (result, input) => {
      seedAssignments(
        queryClient,
        input.org,
        input.classroom,
        result.assignments,
      )
      onWrite?.(result, input)
    },
  })
}

export default useEditAssignment
