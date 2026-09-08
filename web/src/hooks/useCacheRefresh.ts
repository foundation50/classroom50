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

// Roster invite-status lists for every classroom team in the org.
export function useInvalidateInviteQueries(org: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(
    () => invalidateInviteQueries(queryClient, org),
    [queryClient, org],
  )
}

// Everything the viewer's org list derives from (see invalidateViewerOrgs).
export function useInvalidateViewerOrgs(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => invalidateViewerOrgs(queryClient), [queryClient])
}

// The org policy audit, whatever plan the cached run used.
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
