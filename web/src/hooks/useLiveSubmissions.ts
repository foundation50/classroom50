import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  REPO_READ_CONCURRENCY,
  githubKeys,
  latestSubmitReleaseWithAssets,
  retryOnRateLimit,
  withGithubReadSlot,
} from "@/github-core/queries"
import type { GitHubRelease } from "@/github-core/types"
import { studentRepoName } from "@/util/studentRepo"
import { mapWithConcurrency } from "@/util/concurrency"

// How many of an assignment's repos the live fan-out reads per page ("Show
// next N"). One source of truth: the hook defaults `pageSize` to this and the
// page's control label derives its N from it, so the two can't drift.
export const LIVE_PAGE_SIZE = 50

// One student/group repo's live submission state, read directly from its
// `submit/*` releases — independent of the collected scores.json snapshot.
// `owner` is the repo-name component (the individual student login, or the
// group founder). This is the *presence* shape: whether a submission exists,
// when, and the release link. The graded fields (score/tests) are added once
// the result.json asset-download path is resolved (see the plan's U2 spike);
// keeping presence separate lets that drop in without reshaping callers.
export type LiveSubmission = {
  owner: string
  submittedAt: string
  releaseUrl: string
  tag: string
}

export type UseLiveSubmissionsResult = {
  // Live submissions found on the current page window, in completion order and
  // original-case owner; the dashboard merge unions these over the snapshot by
  // owner (case-insensitive).
  submissions: LiveSubmission[]
  // Repo owners on the current page that could not be read (404 is treated as
  // "not submitted", so these are the 403/5xx/network failures). Surfaced so
  // the UI can say "k repos couldn't be read" rather than silently undercount.
  errorCount: number
  isFetching: boolean
  // True only while the FIRST fetch for the current inputs is in flight (not a
  // background refetch). Callers gate flash-prone derived state (e.g. the
  // "not submitted" list) on this so a row doesn't first render not-submitted
  // and then jump to Pending once live presence lands.
  isPending: boolean
  // True when more owners remain beyond the current page window.
  hasNextPage: boolean
  // Force a re-read of the current page's live submissions, bypassing the
  // staleTime — wired to the page's Refresh control so it refreshes live
  // presence alongside the collected snapshot.
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
  // 0-based page index; each page reads `pageSize` owners.
  page?: number
  pageSize?: number
  // Off switch: empty_repo assignments never autograde, so the page disables
  // the fan-out rather than reading releases that can't exist.
  enabled?: boolean
}

// Reads live submissions for the current page of an assignment's repos, one
// bounded-concurrency fan-out of `latestSubmitReleaseWithAssets` per owner.
// Assignment-scoped (never the whole org) and paginated so a 500-student class
// costs one release call per owner in a 50-owner window, not 500 at once. A
// single repo's non-404 failure is caught per-repo (like useGroupRepoMemberLogins)
// so it can't void the whole batch.
export function useLiveSubmissions({
  org,
  classroom,
  assignment,
  repoOwners,
  page = 0,
  pageSize = LIVE_PAGE_SIZE,
  enabled = true,
}: UseLiveSubmissionsArgs): UseLiveSubmissionsResult {
  const client = useGitHubClient()

  const start = page * pageSize
  const windowOwners = useMemo(
    () => repoOwners.slice(start, start + pageSize),
    [repoOwners, start, pageSize],
  )
  const hasNextPage = start + pageSize < repoOwners.length

  // Stable key over the exact window (sorted) so the batch only refires when
  // the owner set or page changes, not on every render.
  const windowKey = useMemo(
    () =>
      [...windowOwners]
        .map((o) => o.toLowerCase())
        .sort()
        .join(","),
    [windowOwners],
  )

  const active =
    enabled &&
    Boolean(org && classroom && assignment) &&
    windowOwners.length > 0

  const { data, isFetching, isLoading, refetch } = useQuery({
    queryKey: [
      ...githubKeys.all,
      "live-submissions",
      org ?? "",
      classroom ?? "",
      assignment ?? "",
      page,
      windowKey,
    ] as const,
    queryFn: async ({ signal }) => {
      const submissions: LiveSubmission[] = []
      let errorCount = 0

      await mapWithConcurrency(
        windowOwners,
        REPO_READ_CONCURRENCY,
        async (owner) => {
          const repo = studentRepoName(classroom!, assignment!, owner)
          try {
            // Route through the shared read slot so this fan-out and any other
            // per-repo fan-out on the page (e.g. group-member reads) share one
            // concurrency budget, and retry once on a rate-limit before giving
            // up on a repo.
            const release = await withGithubReadSlot(() =>
              retryOnRateLimit(() =>
                latestSubmitReleaseWithAssets(client, org!, repo, signal),
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
              })
            }
          } catch {
            // A non-404 failure (403/5xx/network, or a rate-limit that persisted
            // past one retry) for one repo must not void the whole page — count
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
    hasNextPage,
    // Fire-and-forget; narrow react-query's promise to void.
    refetch: () => {
      void refetch()
    },
  }
}

export default useLiveSubmissions
