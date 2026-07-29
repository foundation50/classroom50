import { useCallback } from "react"
import { useQueries } from "@tanstack/react-query"
import type { QueryObserverResult } from "@tanstack/react-query"

import { isOwnerGitHubOrgRole } from "@/authz"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  classifyServiceTokenExpiry,
  getLastCollectScoresRun,
  getServiceTokenStatus,
  githubKeys,
  type ServiceTokenStatus,
} from "@/github-core/queries"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import {
  deriveOrgServiceTokenHealth,
  isCollectRunFailing,
  type OrgServiceTokenHealth,
} from "@/util/serviceTokenHealth"

// The single predicate for "an org whose service token this viewer can manage":
// only an owner of a Classroom 50-ready org can read/set the token (a
// non-owner 403s on the owner-only secret read). Both the org home and the
// global Settings list derive their token-health set from this, and
// useOrgAffordances' per-card `canManageToken` mirrors it — one source so the
// three surfaces can't disagree.
export function isOwnedReadyOrg(summary: Classroom50OrgSummary): boolean {
  return (
    isOwnerGitHubOrgRole(summary.membership.role) &&
    summary.classroom50.status === "ready"
  )
}

export type OrgTokenHealthEntry = {
  org: string
  health: OrgServiceTokenHealth
  // The recorded expiry (RFC 3339), when known — lets the UI show a date.
  expiresAt?: string
  // The token's stored display name, when known.
  tokenName?: string
  // True until both per-org reads resolve, so the chip can show a placeholder
  // rather than flashing a wrong verdict.
  loading: boolean
}

// Cross-org service-token health for the org home. For each org the viewer owns
// (student/member orgs would 403 on the secret read), fan out the token status
// (incl. the expiry variable) and the last completed collect run, then reduce
// each to one verdict. Reuses the same per-org query keys as the single-org
// panes, so the reads share cache with OrgSettings / Submissions rather than
// duplicating calls.
//
// `enabled` gates the whole fan-out (the home page turns it on once the org
// list has resolved). Owner-only reads that 403 resolve to "unknown", never a
// false "missing".
export function useOrgServiceTokenHealth(
  ownedOrgs: string[],
  enabled: boolean,
): { byOrg: Record<string, OrgTokenHealthEntry>; anyLoading: boolean } {
  const client = useGitHubClient()

  // `combine` runs on every render; react-query only memoizes its result when
  // the callback identity is stable, so wrap it in useCallback keyed on
  // `ownedOrgs` — otherwise a fresh `byOrg` is re-derived on unrelated
  // re-renders (e.g. every keystroke in the org search box).
  const combine = useCallback(
    (results: QueryObserverResult[]) => {
      const byOrg: Record<string, OrgTokenHealthEntry> = {}
      let anyLoading = false

      // results are laid out as [tokenStatus, lastRun] per org, in ownedOrgs
      // order.
      ownedOrgs.forEach((org, i) => {
        const statusResult = results[i * 2]
        const runResult = results[i * 2 + 1]
        const status = statusResult?.data as ServiceTokenStatus | undefined
        const run = runResult?.data as { conclusion: string | null } | null
        const loading =
          (statusResult?.isLoading ?? false) || (runResult?.isLoading ?? false)
        if (loading) anyLoading = true

        const tokenStatus = status?.status ?? "unknown"
        const expiresAt =
          status?.status === "present" ? status.expiresAt : undefined
        const tokenName =
          status?.status === "present" ? status.tokenName : undefined

        // An errored run read is inconclusive, NOT a clean "not failing" — pass
        // "unknown" so a transient run-read failure can't certify a card "ok"
        // (and thereby hide a real collectFailing).
        const lastCollectFailing = runResult?.isError
          ? "unknown"
          : isCollectRunFailing(run?.conclusion ?? null)

        byOrg[org] = {
          org,
          expiresAt,
          tokenName,
          loading,
          health: deriveOrgServiceTokenHealth({
            tokenStatus,
            expiry: classifyServiceTokenExpiry(expiresAt),
            lastCollectFailing,
          }),
        }
      })

      return { byOrg, anyLoading }
    },
    [ownedOrgs],
  )

  // `combine` builds the derived map directly off the query cache, so it
  // memoizes on the underlying results (no hand-synced signature string, no
  // eslint-disabled deps). `retry: false` keeps a GitHub outage from turning a
  // multi-org fan-out (2N reads) into a retry storm — a transient failure just
  // yields "unknown"/inconclusive for one card until the next staleTime
  // refetch, matching the sibling releasesQuery.
  return useQueries({
    queries: ownedOrgs.flatMap((org) => [
      {
        queryKey: githubKeys.serviceToken(org),
        queryFn: () => getServiceTokenStatus(client, org),
        enabled: enabled && Boolean(org),
        staleTime: 10 * 60 * 1000,
        retry: false,
      },
      {
        queryKey: githubKeys.lastCollectScoresRun(org),
        queryFn: ({ signal }: { signal?: AbortSignal }) =>
          getLastCollectScoresRun(client, org, signal),
        enabled: enabled && Boolean(org),
        staleTime: 10 * 60 * 1000,
        retry: false,
      },
    ]),
    combine,
  })
}

export default useOrgServiceTokenHealth
