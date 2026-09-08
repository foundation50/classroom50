import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import {
  githubKeys,
  invalidateInviteQueries,
  invalidateViewerOrgs,
} from "@/github-core/queries"

// Read-side refreshes a page triggers without a mutation of its own (a Refresh
// or Recheck button, or a completion callback from a component-run fan-out).
// They live here so `useQueryClient` and `githubKeys` stay out of `pages/`
// (AGENTS.md); each wraps the single-sourced invalidator in keys.ts.

export function useInvalidateInviteQueries(org: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(
    () => invalidateInviteQueries(queryClient, org),
    [queryClient, org],
  )
}

export function useInvalidateViewerOrgs(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => invalidateViewerOrgs(queryClient), [queryClient])
}

export function useInvalidateOrgAudit(org: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      }),
    [queryClient, org],
  )
}
