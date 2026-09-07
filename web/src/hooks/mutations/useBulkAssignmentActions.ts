import { useCallback, useEffect, useRef, useState } from "react"
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

// Write boundary for the assignments page's bulk bar.

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
    // No keepTabOpen: a single git-data commit strands nothing.
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

// bulkCopyAssignments with its progress as state. Owned by the bulk bar, not
// the reuse dialog, so a dismissed dialog can't orphan a run in flight.
export function useBulkReuseAssignments(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const canGrantTemplateAccess = useCanAttemptTemplateGrant()
  const [state, setState] = useState<BulkReuseState>(IDLE)
  // `running` reaches the button a render late; a double-click would start two
  // loops writing the same assignments.json.
  const runningRef = useRef(false)
  // Once the owner unmounts nothing can report the result, so the loop defers
  // the remaining copies instead of finishing headless.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(
    async (items: BulkCopyItem[], targetClassroom: string) => {
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
          shouldContinue: () => mountedRef.current,
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

  // Back to the form for the next run; a no-op while one is in flight.
  const reset = useCallback(() => {
    if (!runningRef.current) setState(IDLE)
  }, [])

  return { ...state, run, reset }
}

export type BulkReuseRun = ReturnType<typeof useBulkReuseAssignments>
