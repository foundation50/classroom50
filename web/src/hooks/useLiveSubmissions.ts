import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  REPO_READ_CONCURRENCY,
  githubKeys,
  latestSubmitReleaseAndCount,
  retryOnRateLimit,
  withGithubReadSlot,
} from "@/github-core/queries"
import type { GitHubRelease } from "@/github-core/types"
import { studentRepoName } from "@/util/studentRepo"
import { mapWithConcurrency } from "@/util/concurrency"

// One student/group repo's live submission state, read directly from its
// `submit/*` releases — independent of the collected scores.json snapshot.
// `owner` is the repo-name component (the individual student login, or the
// group founder). This is the *presence* shape: whether a submission exists,
// when, and the release link. The graded fields (score/tests) live inside the
// release asset (result.json), which can't be read cross-origin from the
// browser, so they stay sourced from the collected snapshot.
export type LiveSubmission = {
  owner: string
  submittedAt: string
  releaseUrl: string
  tag: string
  // How many `submit/*` releases the repo has — the live submission count,
  // read from the same request as the presence fields (no extra API call). A
  // lower bound: it saturates at one page (100). The dashboard merges this onto
  // the collected snapshot row so a student who pushed again after the last
  // collection shows the up-to-date count.
  submissionCount: number
}

export type UseLiveSubmissionsResult = {
  // Live submissions found, in completion order and original-case owner; the
  // dashboard merge unions these over the snapshot by owner (case-insensitive).
  submissions: LiveSubmission[]
  // Repo owners that could not be read (404 is treated as "not submitted", so
  // these are the 403/5xx/network failures). Surfaced so the UI can say "k
  // repos couldn't be read" rather than silently undercount.
  errorCount: number
  isFetching: boolean
  // True only while the FIRST fetch for the current inputs is in flight (not a
  // background refetch). Callers gate flash-prone derived state (e.g. the
  // "not submitted" list) on this so a row doesn't first render not-submitted
  // and then jump to Pending once live presence lands.
  isPending: boolean
  // Force a re-read of the live submissions, bypassing the staleTime — wired to
  // the page's Refresh control so it refreshes live presence alongside the
  // collected snapshot.
  refetch: () => void
}

const submitReleaseTime = (release: GitHubRelease): string =>
  release.published_at ?? release.created_at

export type UseLiveSubmissionsArgs = {
  org: string | undefined
  classroom: string | undefined
  assignment: string | undefined
  // Repo-name owner segments: roster/team logins for individual assignments,
  // group-founder logins (from existingGroupRepos) for group assignments.
  repoOwners: string[]
  // Off switch: empty_repo assignments never autograde, so the page disables
  // the fan-out rather than reading releases that can't exist.
  enabled?: boolean
}

// Reads live submissions for an assignment's repos, one bounded-concurrency
// fan-out of `latestSubmitReleaseAndCount` per owner in `repoOwners`.
// Assignment-scoped (never the whole org) and PAGE-SCOPED by the caller: the
// dashboard passes only the current table page's owners, so a large class is
// read a page at a time, throttled by the shared read-slot semaphore
// (REPO_READ_CONCURRENCY). A single repo's non-404 failure is caught per-repo
// (like useGroupRepoMemberLogins) so it can't void the whole batch.
export function useLiveSubmissions({
  org,
  classroom,
  assignment,
  repoOwners,
  enabled = true,
}: UseLiveSubmissionsArgs): UseLiveSubmissionsResult {
  const client = useGitHubClient()

  // Stable key over the exact owner set (sorted) so the batch only refires when
  // the owners change, not on every render.
  const ownersKey = useMemo(
    () =>
      [...repoOwners]
        .map((o) => o.toLowerCase())
        .sort()
        .join(","),
    [repoOwners],
  )

  const active =
    enabled && Boolean(org && classroom && assignment) && repoOwners.length > 0

  const { data, isFetching, isLoading, refetch } = useQuery({
    queryKey: [
      ...githubKeys.all,
      "live-submissions",
      org ?? "",
      classroom ?? "",
      assignment ?? "",
      ownersKey,
    ] as const,
    queryFn: async ({ signal }) => {
      const submissions: LiveSubmission[] = []
      let errorCount = 0

      await mapWithConcurrency(
        repoOwners,
        REPO_READ_CONCURRENCY,
        async (owner) => {
          const repo = studentRepoName(classroom!, assignment!, owner)
          try {
            // Route through the shared read slot so this fan-out and any other
            // per-repo fan-out on the page (e.g. group-member reads) share one
            // concurrency budget, and retry once on a rate-limit before giving
            // up on a repo.
            const { latest: release, count } = await withGithubReadSlot(() =>
              retryOnRateLimit(() =>
                latestSubmitReleaseAndCount(client, org!, repo, signal),
              ),
            )
            // 404 (repo not accepted) resolves to null inside the query — that
            // is "not submitted", not an error.
            if (release) {
              submissions.push({
                owner,
                submittedAt: submitReleaseTime(release),
                releaseUrl: release.html_url,
                tag: release.tag_name,
                submissionCount: count,
              })
            }
          } catch (err) {
            // An abort (key change / unmount) rejects the whole run: swallowing
            // it here would let the queryFn resolve with a partial result that
            // react-query then caches fresh under the now-inactive owners key, so
            // revisiting that page within staleTime reads an inflated errorCount
            // and missing rows. Rethrow so the cancelled run is discarded.
            if (signal.aborted || (err as Error)?.name === "AbortError")
              throw err
            // A non-404 failure (403/5xx/network, or a rate-limit that persisted
            // past one retry) for one repo must not void the whole batch — count
            // it and move on.
            errorCount++
          }
        },
      )

      return { submissions, errorCount }
    },
    enabled: active,
    staleTime: 60 * 1000,
    retry: false,
  })

  const empty = useMemo(() => [] as LiveSubmission[], [])

  return {
    submissions: data?.submissions ?? empty,
    errorCount: data?.errorCount ?? 0,
    isFetching,
    // A disabled fan-out (empty_repo, or no owners) has nothing to wait for, so
    // it is never pending; otherwise it's pending until the first result lands.
    isPending: active && isLoading,
    // Fire-and-forget; narrow react-query's promise to void.
    refetch: () => {
      void refetch()
    },
  }
}

export default useLiveSubmissions
