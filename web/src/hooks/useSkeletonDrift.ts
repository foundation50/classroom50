import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { findStaleSkeletonFiles } from "./github/mutations"
import { githubKeys } from "./github/queries"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"

// State subset the verdict depends on — structural so the fail-open logic stays
// a pure, testable function.
export type SkeletonDriftInput = {
  isSuccess: boolean
  driftedCount: number | undefined
  isError: boolean
}

// Fail-open verdict: show only on a definitive success that found drift. A read
// error or in-flight query resolves to "no drift" so we never nag on incomplete
// info.
export function resolveSkeletonDrift(input: SkeletonDriftInput): boolean {
  const { isSuccess, driftedCount, isError } = input
  if (isError || !isSuccess) return false
  return (driftedCount ?? 0) > 0
}

// Owner-gated, cached, fail-open check for whether the org's `classroom50`
// config repo has drifted from the bundled skeleton. Reuses findStaleSkeletonFiles
// read-only — no version marker.
//
// Gated on org owner (admin), not any staff: the banner routes to the owner-only
// Re-run org setup section, so surfacing it to a TA/non-owner instructor would
// dead-end their CTA on a NotFound.
export function useSkeletonDrift(org: string | undefined) {
  const client = useGitHubClient()
  const { orgRole } = useOrgRole()
  const isOwner = can("manageOrg", { orgRole })

  const query = useQuery({
    queryKey: githubKeys.skeletonDrift(org ?? ""),
    queryFn: () => findStaleSkeletonFiles(client, org as string),
    enabled: Boolean(org) && isOwner,
    staleTime: 30 * 60 * 1000,
    // Fail-open (see resolveSkeletonDrift); no point retrying a check whose
    // failure mode is "stay quiet".
    retry: false,
  })

  const hasDrift = resolveSkeletonDrift({
    isSuccess: query.isSuccess,
    driftedCount: query.data?.length,
    isError: query.isError,
  })

  return { ...query, hasDrift }
}
