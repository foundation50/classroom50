import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  createAssignment,
  type CreateAssignmentInput,
  type CreateAssignmentResult,
} from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"
import { CONFIG_REPO } from "@/util/configRepo"

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
    mutationFn: (input) =>
      createAssignment(client, { ...input, canGrantTemplateAccess }),
    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${classroom}/assignments.json`,
        ),
      })
      onWrite?.(result, input)
    },
  })
}

export default useCreateAssignment
