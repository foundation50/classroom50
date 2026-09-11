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

// While a blocking Pages deployment is still in progress, re-read its status on
// this cadence so the row flips to "cleared, retry now" on its own. GitHub
// releases a stuck deployment within about 10 minutes.
const BLOCKER_POLL_MS = 15_000

export type PublishFailureDetail =
  | { state: "loading" }
  // The annotations named no known cause (or could not be read): the run link
  // is the only detail on offer.
  | { state: "unknown" }
  | {
      state: "known"
      failure: PublishFailure
      // Only for deployLocked: whether the blocking deployment still holds the
      // lock. `undefined` while the probe is in flight or unreadable, in which
      // case the row keeps the cautious "still finishing" wording.
      blockerInProgress?: boolean
    }

// Why a failed publish run failed, from the deploy job's annotations, plus a
// live probe of the blocking deployment when the cause is GitHub's one-at-a-
// time Pages lock. Reads only once a run has failed; `runId` undefined
// disables everything.
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
      // null = GitHub no longer has it, so the lock is gone.
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
