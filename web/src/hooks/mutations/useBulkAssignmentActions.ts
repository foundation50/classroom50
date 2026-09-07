import { useCallback, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import {
  bulkCopyAssignments,
  deleteAssignmentsWithConflictRetry,
  setAssignmentsLockWithConflictRetry,
  type BulkCopyItem,
  type BulkCopyOutcome,
  type BulkDeleteResult,
  type BulkLockResult,
} from "@/domain/assignments"

// Write boundary for the assignments page's bulk bar. Lock and delete are
// ordinary mutations over the batched domain functions; reuse cannot batch
// (see bulkCopyAssignments), so it runs the domain loop and exposes its
// progress and per-assignment outcomes as state.

function invalidateAssignments(
  queryClient: ReturnType<typeof useQueryClient>,
  org: string,
  classroom: string,
) {
  void queryClient.invalidateQueries({
    queryKey: githubKeys.jsonFile(
      org,
      CONFIG_REPO,
      `${classroom}/assignments.json`,
    ),
  })
}

export function useBulkSetAssignmentLock(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    BulkLockResult,
    Error,
    { slugs: string[]; locked: boolean }
  >({
    // One commit, then a template grant/revoke per selected assignment.
    meta: { keepTabOpen: true },
    mutationFn: ({ slugs, locked }) =>
      setAssignmentsLockWithConflictRetry(client, {
        org,
        classroom,
        slugs,
        locked,
      }),
    onSuccess: () => invalidateAssignments(queryClient, org, classroom),
  })
}

export function useBulkDeleteAssignments(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<BulkDeleteResult, Error, { slugs: string[] }>({
    // Not flagged keepTabOpen: one git-data commit, dangling until the ref
    // moves, so a closed tab strands nothing.
    mutationFn: ({ slugs }) =>
      deleteAssignmentsWithConflictRetry(client, { org, classroom, slugs }),
    onSuccess: () => invalidateAssignments(queryClient, org, classroom),
  })
}

export type BulkReuseState = {
  running: boolean
  processed: number
  total: number
  outcomes: BulkCopyOutcome[]
}

const IDLE: BulkReuseState = {
  running: false,
  processed: 0,
  total: 0,
  outcomes: [],
}

// React shell around bulkCopyAssignments: the run's progress as state, the
// re-entrancy latch, and the target classroom's query invalidation.
export function useBulkReuseAssignments(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const canGrantTemplateAccess = useCanAttemptTemplateGrant()
  const [state, setState] = useState<BulkReuseState>(IDLE)
  // Synchronous re-entrancy latch, the same one useReuseAssignment carries:
  // `running` reaches the button a render later, so a double-click would
  // otherwise start two loops writing the same assignments.json and
  // interleaving their progress into one state.
  const runningRef = useRef(false)

  const run = useCallback(
    async (items: BulkCopyItem[], targetClassroom: string) => {
      // Outcomes are read off `state`; the caller awaits nothing.
      if (runningRef.current) return
      runningRef.current = true
      setState({
        running: true,
        processed: 0,
        total: items.length,
        outcomes: [],
      })

      try {
        await bulkCopyAssignments(client, {
          org,
          targetClassroom,
          items,
          canGrantTemplateAccess,
          onProgress: (outcomes) =>
            setState((prev) => ({
              ...prev,
              processed: outcomes.length,
              outcomes,
            })),
        })
      } finally {
        runningRef.current = false
        invalidateAssignments(queryClient, org, targetClassroom)
        setState((prev) => ({ ...prev, running: false }))
      }
    },
    [client, org, canGrantTemplateAccess, queryClient],
  )

  return { ...state, run }
}
