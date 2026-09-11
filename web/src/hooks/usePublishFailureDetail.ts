import { useQuery } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import {
  getPagesDeploymentStatus,
  getRunAnnotations,
  githubKeys,
  isPagesDeploymentInProgress,
} from "@/github-core/queries"
import {
  classifyPublishFailure,
  type PublishFailure,
} from "@/util/actionActivity"

// Re-read a blocking deployment on this cadence so the row flips to "cleared"
// on its own once GitHub releases it.
const BLOCKER_POLL_MS = 15_000

export type PublishFailureDetail =
  | { state: "loading" }
  // No known cause in the annotations (or they couldn't be read).
  | { state: "unknown" }
  | {
      state: "known"
      failure: PublishFailure
      // deployLocked only. `undefined` while the probe is in flight or
      // unreadable, which keeps the cautious "still finishing" wording.
      blockerInProgress?: boolean
    }

// Why a failed publish run failed, plus a live probe of the blocking deployment
// when the cause is the Pages lock. `runId` undefined disables both reads.
export function usePublishFailureDetail(
  org: string | undefined,
  runId: number | undefined,
): PublishFailureDetail {
  const client = useOptionalGitHubClient()
  const enabled = Boolean(client && org && runId !== undefined)

  const annotations = useQuery({
    queryKey: githubKeys.runAnnotations(org ?? "", runId ?? 0),
    queryFn: ({ signal }) =>
      getRunAnnotations(client!, org ?? "", runId ?? 0, signal),
    enabled,
    // A completed run's annotations never change.
    staleTime: Infinity,
    retry: false,
  })

  const failure = annotations.data
    ? classifyPublishFailure(annotations.data)
    : undefined
  const blockerSha =
    failure?.kind === "deployLocked" ? failure.blockerSha : undefined

  const blocker = useQuery({
    queryKey: githubKeys.pagesDeployment(org ?? "", blockerSha ?? ""),
    queryFn: ({ signal }) =>
      getPagesDeploymentStatus(client!, org ?? "", blockerSha ?? "", signal),
    enabled: enabled && blockerSha !== undefined,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data
      if (status === undefined) return BLOCKER_POLL_MS
      return status !== null && isPagesDeploymentInProgress(status)
        ? BLOCKER_POLL_MS
        : false
    },
    retry: false,
  })

  if (!enabled) return { state: "unknown" }
  if (annotations.isPending) return { state: "loading" }
  if (!failure) return { state: "unknown" }
  if (failure.kind !== "deployLocked") return { state: "known", failure }

  const blockerInProgress =
    blocker.data === undefined
      ? undefined
      : blocker.data !== null && isPagesDeploymentInProgress(blocker.data)
  return { state: "known", failure, blockerInProgress }
}

export default usePublishFailureDetail
