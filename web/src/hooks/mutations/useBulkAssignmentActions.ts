import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"
import { seedAssignments } from "@/github-core/queries"
import {
  copyAssignmentsWithConflictRetry,
  deleteAssignmentsWithConflictRetry,
  setAssignmentsLockWithConflictRetry,
  type BulkCopyItem,
  type BulkCopyResult,
  type BulkDeleteResult,
  type BulkLockResult,
} from "@/domain/assignments"

// Write boundary for the assignments page's bulk bar.

export function useBulkSetAssignmentLock(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    BulkLockResult,
    Error,
    { slugs: string[]; locked: boolean }
  >({
    // One commit, then a grant or revoke per distinct template in the selection.
    meta: { keepTabOpen: true },
    mutationFn: ({ slugs, locked }) =>
      setAssignmentsLockWithConflictRetry(client, {
        org,
        classroom,
        slugs,
        locked,
      }),
    onSuccess: (result) =>
      seedAssignments(queryClient, org, classroom, result.assignments),
  })
}

export function useBulkDeleteAssignments(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<BulkDeleteResult, Error, { slugs: string[] }>({
    // No keepTabOpen: a single git-data commit strands nothing.
    mutationFn: ({ slugs }) =>
      deleteAssignmentsWithConflictRetry(client, { org, classroom, slugs }),
    onSuccess: (result) =>
      seedAssignments(queryClient, org, classroom, result.assignments),
  })
}

export function useBulkReuseAssignments(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const canGrantTemplateAccess = useCanAttemptTemplateGrant()

  return useMutation<
    BulkCopyResult,
    Error,
    { items: BulkCopyItem[]; targetClassroom: string }
  >({
    // One commit, then a grant per distinct template among the copies.
    meta: { keepTabOpen: true },
    mutationFn: ({ items, targetClassroom }) =>
      copyAssignmentsWithConflictRetry(client, {
        org,
        targetClassroom,
        items,
        canGrantTemplateAccess,
      }),
    onSuccess: (result, { targetClassroom }) =>
      seedAssignments(queryClient, org, targetClassroom, result.assignments),
  })
}
