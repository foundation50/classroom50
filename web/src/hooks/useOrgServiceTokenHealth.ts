import { useQueries } from "@tanstack/react-query"
import { useMemo } from "react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  classifyServiceTokenExpiry,
  getLastCollectScoresRun,
  getServiceTokenStatus,
  githubKeys,
  type ServiceTokenStatus,
} from "@/github-core/queries"
import {
  deriveOrgServiceTokenHealth,
  isCollectRunFailing,
  type OrgServiceTokenHealth,
} from "@/util/serviceTokenHealth"

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

  const results = useQueries({
    queries: ownedOrgs.flatMap((org) => [
      {
        queryKey: githubKeys.serviceToken(org),
        queryFn: () => getServiceTokenStatus(client, org),
        enabled: enabled && Boolean(org),
        staleTime: 10 * 60 * 1000,
      },
      {
        queryKey: githubKeys.lastCollectScoresRun(org),
        queryFn: ({ signal }: { signal?: AbortSignal }) =>
          getLastCollectScoresRun(client, org, signal),
        enabled: enabled && Boolean(org),
        staleTime: 10 * 60 * 1000,
      },
    ]),
  })

  // results are laid out as [tokenStatus, lastRun] per org, in ownedOrgs order.
  const signature = ownedOrgs
    .map((org, i) => {
      const status = results[i * 2]?.data as ServiceTokenStatus | undefined
      const run = results[i * 2 + 1]?.data as {
        conclusion: string | null
      } | null
      const loading =
        (results[i * 2]?.isLoading ?? false) ||
        (results[i * 2 + 1]?.isLoading ?? false)
      const expiresAt =
        status?.status === "present" ? status.expiresAt : undefined
      const tokenName =
        status?.status === "present" ? status.tokenName : undefined
      return `${org}=${status?.status ?? "?"}:${expiresAt ?? "-"}:${
        tokenName ?? "-"
      }:${run?.conclusion ?? "-"}:${loading ? "L" : "R"}`
    })
    .join("\n")

  return useMemo(() => {
    const byOrg: Record<string, OrgTokenHealthEntry> = {}
    let anyLoading = false

    ownedOrgs.forEach((org, i) => {
      const status = results[i * 2]?.data as ServiceTokenStatus | undefined
      const run = results[i * 2 + 1]?.data as {
        conclusion: string | null
      } | null
      const loading =
        (results[i * 2]?.isLoading ?? false) ||
        (results[i * 2 + 1]?.isLoading ?? false)
      if (loading) anyLoading = true

      const tokenStatus = status?.status ?? "unknown"
      const expiresAt =
        status?.status === "present" ? status.expiresAt : undefined
      const tokenName =
        status?.status === "present" ? status.tokenName : undefined

      byOrg[org] = {
        org,
        expiresAt,
        tokenName,
        loading,
        health: deriveOrgServiceTokenHealth({
          tokenStatus,
          expiry: classifyServiceTokenExpiry(expiresAt),
          lastCollectFailing: isCollectRunFailing(run?.conclusion ?? null),
        }),
      }
    })

    return { byOrg, anyLoading }
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
}

export default useOrgServiceTokenHealth
