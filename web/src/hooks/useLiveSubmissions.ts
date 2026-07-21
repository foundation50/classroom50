import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  REPO_READ_CONCURRENCY,
  githubKeys,
  latestSubmitReleaseWithAssets,
} from "@/github-core/queries"
import type { GitHubRelease } from "@/github-core/types"
import { studentRepoName } from "@/util/studentRepo"
import { mapWithConcurrency } from "@/util/concurrency"

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
  // Live submissions found on the current page window, keyed insertion-free by
  // owner (lowercased) so the merge in the dashboard can union by owner.
  submissions: LiveSubmission[]
  // Repo owners on the current page that could not be read (404 is treated as
  // "not submitted", so these are the 403/5xx/network failures). Surfaced so
  // the UI can say "k repos couldn't be read" rather than silently undercount.
  errorCount: number
  isFetching: boolean
  // True when more owners remain beyond the current page window.
  hasNextPage: boolean
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
  pageSize = 50,
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

  const { data, isFetching } = useQuery({
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
            const release = await latestSubmitReleaseWithAssets(
              client,
              org!,
              repo,
              signal,
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
            // A non-404 failure (403/5xx/network after retries) for one repo
            // must not void the whole page — count it and move on.
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
    hasNextPage,
  }
}

export default useLiveSubmissions
