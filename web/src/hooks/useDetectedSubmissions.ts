import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { GitHubClient } from "@/github-core/client"
import {
  REPO_READ_CONCURRENCY,
  githubKeys,
  getCommitDatetime,
  getOldestCommitShaForPath,
  listDefaultBranchCommits,
  listRepoTags,
  retryOnRateLimit,
  withGithubReadSlot,
} from "@/github-core/queries"
import { getRepo } from "@/github-core/repoReads"
import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"
import type { SubmissionMode } from "@/types/classroom"
import {
  detectBranchSubmissions,
  detectTagSubmissions,
  detectedSubmissionCount,
  resolveSubmissionMode,
  type DetectedSubmission,
} from "@/domain/assignments/submissionDetection"
import { studentRepoName } from "@/util/studentRepo"
import { mapWithConcurrency } from "@/util/concurrency"

// One repo's detected submissions, read directly from the repo state (default-
// branch commits for branch mode, git tags for tag mode) rather than from
// submit/* releases. `owner` is the repo-name component. `count` is the total
// number of submissions detected (a glob group counts its matches); `entries`
// carries the per-submission breakdown for future per-row detail.
export type DetectedRepoSubmissions = {
  owner: string
  count: number
  entries: DetectedSubmission[]
}

export type UseDetectedSubmissionsResult = {
  detected: DetectedRepoSubmissions[]
  // Repo owners that couldn't be read (non-404 failures; 404 is "not accepted").
  errorCount: number
  isFetching: boolean
  isPending: boolean
  refetch: () => void
}

export type UseDetectedSubmissionsArgs = {
  org: string | undefined
  classroom: string | undefined
  assignment: string | undefined
  // The submission definition: "every-push" (branch) or "tag". Absent reads as
  // branch mode: the schema's wire default, which writers omit.
  mode: SubmissionMode | undefined
  // Milestone tag patterns for tag mode (union with the always-on submit/*).
  submissionTags?: string[]
  // Page-scoped repo-name owner segments (mirror useLiveSubmissions).
  repoOwners: string[]
  // Off switch: an empty_repo assignment has nothing to detect.
  enabled?: boolean
}

// Reads detected submissions for an assignment's repos, one bounded-concurrency
// fan-out per owner — mirroring useLiveSubmissions on the three fan-out
// invariants (R8): PAGE-SCOPED by the caller (only the current table page's
// owners), aggregate-bounded through the shared read-slot semaphore, and never
// fed its own merged output. Branch mode reads each repo's default branch +
// baseline + commit log; tag mode reads its git tags. A single repo's non-404
// failure is caught per-repo so it can't void the batch.
export function useDetectedSubmissions({
  org,
  classroom,
  assignment,
  mode,
  submissionTags,
  repoOwners,
  enabled = true,
}: UseDetectedSubmissionsArgs): UseDetectedSubmissionsResult {
  const client = useGitHubClient()

  const ownersKey = useMemo(
    () =>
      repoOwners
        .map((o) => o.toLowerCase())
        .toSorted()
        .join(","),
    [repoOwners],
  )

  // Stable key over the tag patterns so a milestone edit refires the batch.
  const tagsKey = useMemo(
    () => (submissionTags ?? []).join("\n"),
    [submissionTags],
  )

  const resolvedMode = resolveSubmissionMode(mode)

  const active =
    enabled && Boolean(org && classroom && assignment) && repoOwners.length > 0

  const { data, isFetching, isLoading, refetch } = useQuery({
    queryKey: [
      ...githubKeys.all,
      "detected-submissions",
      org ?? "",
      classroom ?? "",
      assignment ?? "",
      resolvedMode,
      tagsKey,
      ownersKey,
    ] as const,
    queryFn: async ({ signal }) => {
      const detected: DetectedRepoSubmissions[] = []
      let errorCount = 0

      await mapWithConcurrency(
        repoOwners,
        REPO_READ_CONCURRENCY,
        async (owner) => {
          const repo = studentRepoName(classroom!, assignment!, owner)
          try {
            const entries = await withGithubReadSlot(() =>
              retryOnRateLimit(async () => {
                if (resolvedMode === "tag") {
                  const tags = await listRepoTags(client, org!, repo)
                  // Detection must mirror the shim's trigger, which always
                  // unions the canonical submit/* namespace with the milestone
                  // patterns (see shimTagsList). Without submit/* a tag-mode
                  // assignment with no milestone patterns — the common case,
                  // where students push submit/* tags via `gh student submit` —
                  // would detect nothing. submit/* is a glob, so it groups.
                  const entries = detectTagSubmissions(tags, [
                    ...(submissionTags ?? []),
                    `${SUBMISSION_TAG_PREFIX}*`,
                  ])
                  return dateMilestoneTagEntries(client, org!, repo, entries)
                }
                // Branch mode: resolve the default branch, its baseline, and
                // the commit log; detectBranchSubmissions narrows it.
                const info = await getRepo(client, org!, repo)
                const branch = info?.default_branch
                if (!branch) return [] // not accepted / commitless
                // Resolve the baseline (oldest .classroom50.yaml commit)
                // directly so a genuinely-absent marker reads as null (a bare
                // repo — count every commit) while a transient read failure
                // PROPAGATES: resolveFeedbackBaselineSha swallows every error to
                // null, which would keep the accept/baseline commit and inflate
                // the count by one. Letting it throw routes the repo to the
                // per-repo errorCount/rate-limit retry instead.
                const baseline = await getOldestCommitShaForPath(
                  client,
                  org!,
                  repo,
                  ".classroom50.yaml",
                )
                const commits = await listDefaultBranchCommits(
                  client,
                  org!,
                  repo,
                  branch,
                )
                return detectBranchSubmissions(commits, baseline)
              }),
            )
            if (entries.length > 0) {
              detected.push({
                owner,
                count: detectedSubmissionCount(entries),
                entries,
              })
            }
          } catch (err) {
            if (signal.aborted || (err as Error)?.name === "AbortError")
              throw err
            errorCount++
          }
        },
      )

      return { detected, errorCount }
    },
    enabled: active,
    staleTime: 60 * 1000,
    retry: false,
  })

  const empty = useMemo(() => [] as DetectedRepoSubmissions[], [])

  return {
    detected: data?.detected ?? empty,
    errorCount: data?.errorCount ?? 0,
    isFetching,
    isPending: active && isLoading,
    refetch: () => {
      void refetch()
    },
  }
}

// At most this many per-commit date lookups per repo. Milestone patterns are
// capped at 20 and repos typically carry 1-3, so the cap only bites on a
// pathological tag set — where the newest submit/* time (free, from the tag
// name) usually covers the row anyway.
const MILESTONE_DATE_LOOKUP_CAP = 10

// Fill the datetime of milestone tag entries by reading their tagged commit:
// canonical submit/* names encode their time (already parsed by detection),
// but a milestone tag's only time source is its commit. Lookups are deduped
// by sha; a failed read leaves the entry dateless rather than voiding the
// batch. Runs inside the caller's read slot, so the extra requests stay
// within the fan-out's aggregate bound.
async function dateMilestoneTagEntries(
  client: GitHubClient,
  org: string,
  repo: string,
  entries: DetectedSubmission[],
): Promise<DetectedSubmission[]> {
  const dateless = entries.filter((e) => !e.datetime && e.sha)
  if (dateless.length === 0) return entries

  const shas = [...new Set(dateless.map((e) => e.sha!))].slice(
    0,
    MILESTONE_DATE_LOOKUP_CAP,
  )
  const dateBySha = new Map<string, string>()
  for (const sha of shas) {
    try {
      const date = await getCommitDatetime(client, org, repo, sha)
      if (date) dateBySha.set(sha, date)
    } catch (err) {
      // Best-effort enrichment: a failed lookup must not void the detection
      // entries we already have. Cancellation still propagates.
      if ((err as Error)?.name === "AbortError") throw err
    }
  }
  if (dateBySha.size === 0) return entries

  return entries.map((e) => {
    if (e.datetime || !e.sha) return e
    const date = dateBySha.get(e.sha)
    return date ? { ...e, datetime: date } : e
  })
}

export default useDetectedSubmissions
