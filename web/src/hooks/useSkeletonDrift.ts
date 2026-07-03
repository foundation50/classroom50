import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { findStaleSkeletonFiles } from "./github/mutations"
import { githubKeys } from "./github/queries"
import { useCourseTeacherAccess } from "./useCourseTeacherAccess"

// The subset of the drift query's state the verdict depends on. Structural so
// the fail-open logic stays a pure, unit-testable function (no React Query).
export type SkeletonDriftInput = {
  isSuccess: boolean
  driftedCount: number | undefined
  isError: boolean
}

// Fail-open drift verdict: a banner shows ONLY on a definitive success that
// found at least one drifted/missing skeleton file. A read error (network,
// 5xx, a repo the teacher can't see) or an in-flight query resolves to "no
// drift" so we never nag on incomplete information — mirrors the issue's
// "on any read error, show nothing".
export function resolveSkeletonDrift(input: SkeletonDriftInput): boolean {
  const { isSuccess, driftedCount, isError } = input
  if (isError || !isSuccess) return false
  return (driftedCount ?? 0) > 0
}

// Teacher-gated, cached check for whether the org's `classroom50` config repo
// has scaffolded workflow files that drifted from the bundled skeleton (e.g.
// after a skeleton bump like #88's action-pin update). Reuses the existing
// content-based diff (findStaleSkeletonFiles) read-only — no version marker.
//
// Gated on teacher/owner access so a student never triggers the config-repo
// tree read, cached with a generous staleTime so it doesn't refetch on every
// render, and fail-open: any read error surfaces as "no drift".
export function useSkeletonDrift(org: string | undefined) {
  const client = useGitHubClient()
  const { showTeacherUi } = useCourseTeacherAccess(org)

  const query = useQuery({
    queryKey: githubKeys.skeletonDrift(org ?? ""),
    queryFn: () => findStaleSkeletonFiles(client, org as string),
    enabled: Boolean(org) && showTeacherUi,
    staleTime: 30 * 60 * 1000,
    // Fail-open on read errors (see resolveSkeletonDrift); no point burning
    // retries on a check whose failure mode is "stay quiet".
    retry: false,
  })

  const hasDrift = resolveSkeletonDrift({
    isSuccess: query.isSuccess,
    driftedCount: query.data?.length,
    isError: query.isError,
  })

  return { ...query, hasDrift }
}
