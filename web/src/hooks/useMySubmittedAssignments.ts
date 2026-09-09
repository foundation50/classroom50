import { useQueries } from "@tanstack/react-query"
import { useMemo } from "react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoTagsQuery } from "@/github-core/queries"
import type { GitHubCommit, GitHubTag } from "@/github-core/types"
import {
  detectTagSubmissions,
  detectedSubmissionCount,
  latestDetectedAt,
  latestPushSubmittedAt,
  resolveSubmissionMode,
} from "@/domain/assignments/submissionDetection"
import { myPushSubmissionsQuery } from "@/hooks/useGetMyPushSubmissions"
import { submissionTagPatterns } from "@/hooks/useGetMyTaggedSubmissions"
import type { Assignment } from "@/types/classroom"

// An assignment the student accepted, with the repo that acceptance resolved
// to: their own `<classroom>-<slug>-<login>`, or the group's
// `<classroom>-<slug>-group-<n>` in team mode.
export type AcceptedAssignmentRepo = {
  assignment: Assignment
  repo: string
}

export type MySubmittedAssignments = {
  // Slugs with at least one submission.
  submittedSlugs: ReadonlySet<string>
  // Slug -> newest submission's ISO time, for submitted slugs whose source
  // carries one (a dateless milestone tag is submitted but absent here).
  lastSubmittedAt: ReadonlyMap<string, string>
  isPending: boolean
}

// What the list needs per accepted repo, selected off the cache entry the
// submission page's readers share (push commits, or the raw tag list).
type SubmissionSummary = { count: number; latestAt: string | null }

const summarizePushes = (commits: GitHubCommit[]): SubmissionSummary => ({
  count: commits.length,
  latestAt: latestPushSubmittedAt(commits),
})

const summarizeTags = (
  tags: GitHubTag[],
  patterns: string[],
): SubmissionSummary => {
  const entries = detectTagSubmissions(tags, patterns)
  return {
    count: detectedSubmissionCount(entries),
    latestAt: latestDetectedAt(entries),
  }
}

// Which of the student's accepted assignments have a submission, and when the
// newest landed, read the same way the submission page counts them (push
// commits past the baseline in every-push mode, submit/* or milestone tags in
// tag mode) so the list never disagrees with the page behind it. One query per
// accepted repo, keyed like the page's single-repo readers, so the cache is
// warm when the student opens a row. A repo whose read fails settles as not
// submitted: the row falls back to "Accepted", which is still true.
export function useMySubmittedAssignments(
  org: string,
  accepted: AcceptedAssignmentRepo[],
): MySubmittedAssignments {
  const client = useGitHubClient()

  const { signature, isPending } = useQueries({
    queries: accepted.map(({ assignment, repo }) =>
      resolveSubmissionMode(assignment.submission_mode) === "tag"
        ? {
            ...repoTagsQuery(client, org, repo),
            select: (tags: GitHubTag[]) =>
              summarizeTags(
                tags,
                submissionTagPatterns(assignment.submission_tags),
              ),
          }
        : {
            ...myPushSubmissionsQuery(client, org, repo),
            select: summarizePushes,
          },
    ),
    combine: (results) => ({
      // A string signature rather than collections so the memo below hands
      // callers stable references while the resolved values haven't changed.
      signature: accepted
        .map(({ assignment }, i) => {
          const summary = results[i]?.data
          if (!summary || summary.count === 0) return null
          return `${assignment.slug}\t${summary.latestAt ?? ""}`
        })
        .filter((line) => line !== null)
        .join("\n"),
      isPending: results.some((r) => r.isPending),
    }),
  })

  const { submittedSlugs, lastSubmittedAt } = useMemo(() => {
    const slugs = new Set<string>()
    const at = new Map<string, string>()
    for (const line of signature ? signature.split("\n") : []) {
      const [slug, datetime] = line.split("\t")
      slugs.add(slug)
      if (datetime) at.set(slug, datetime)
    }
    return { submittedSlugs: slugs, lastSubmittedAt: at }
  }, [signature])

  return { submittedSlugs, lastSubmittedAt, isPending }
}

export default useMySubmittedAssignments
