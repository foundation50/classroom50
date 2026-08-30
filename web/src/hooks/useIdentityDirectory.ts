import { useCallback } from "react"
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { GitHubClient } from "@/github-core/client"
import { githubKeys } from "@/github-core/queries"
import { buildIdentityDirectory } from "@/domain/students/identityDirectory"
import {
  resolveEmailRows,
  type ResolveEmailRowsResult,
} from "@/domain/students/resolveEmailRows"

// Single source for the directory's cache entry: the hook and the imperative
// fetch below must share one key and staleTime, or a caller would pay for the
// every-classroom walk twice.
export function identityDirectoryQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: [...githubKeys.all, "identity-directory", org] as const,
    queryFn: () => buildIdentityDirectory(client, org),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// Imperative counterpart for mutation/flow code: served from the same cache
// entry as useIdentityDirectory, building at most once per staleTime window.
export function fetchIdentityDirectory(
  queryClient: QueryClient,
  client: GitHubClient,
  org: string,
) {
  return queryClient.fetchQuery(identityDirectoryQuery(client, org))
}

// The classroom identity directory, built ON DEMAND only (`enabled` gates it):
// it walks every classroom's teams and roster, so a roster with nothing to
// link must never pay for it.
export function useIdentityDirectory(org: string, enabled: boolean) {
  const client = useGitHubClient()
  return useQuery({ ...identityDirectoryQuery(client, org), enabled })
}

// A stable resolver that pulls the directory through the query cache instead
// of letting resolveEmailRows rebuild it per call. Empty input short-circuits
// without touching the cache (never trigger the walk with nothing to resolve).
export function useResolveEmailRows(
  client: GitHubClient,
  org: string,
): (emails: string[]) => Promise<ResolveEmailRowsResult> {
  const queryClient = useQueryClient()
  return useCallback(
    async (emails: string[]) => {
      if (emails.length === 0) return { links: [], degraded: false }
      const directory = await fetchIdentityDirectory(queryClient, client, org)
      return resolveEmailRows(client, org, emails, { directory })
    },
    [queryClient, client, org],
  )
}
