import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoTagsQuery } from "@/github-core/queries"
import type { GitHubCommit, GitHubTag } from "@/github-core/types"
import {
  detectTagSubmissions,
  detectedSubmissionCount,
  latestDetectedAt,
  latestPushSubmittedAt,
  resolveSubmissionMode,
  submissionTagPatterns,
} from "@/domain/assignments/submissionDetection"
import { myPushSubmissionsQuery } from "@/hooks/useGetMyPushSubmissions"
import type { Assignment } from "@/types/classroom"

// An assignment the student accepted, with the repo that acceptance resolved
// to: their own `<classroom>-<slug>-<login>`, or the group's
// `<classroom>-<slug>-group-<n>` in team mode. `defaultBranch` comes from the
// same org repo walk and saves the push read one request.
export type AcceptedAssignmentRepo = {
  assignment: Assignment
  repo: string
  defaultBranch?: string
}

// One accepted repo's submission standing. "unknown" is a failed read: the
// student did accept, but the list can't say whether anything is in, and must
// not claim either way. `latestAt` is null for a submission whose source
// carries no time (a milestone tag).
export type MySubmissionState =
  | { kind: "pending" }
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "submitted"; latestAt: string | null }

const PENDING: MySubmissionState = { kind: "pending" }
const UNKNOWN: MySubmissionState = { kind: "unknown" }
const NONE: MySubmissionState = { kind: "none" }

// What each query reduces its cache entry to (push commits, or the raw tag
// list shared with the submission page's readers).
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

// Per accepted assignment (keyed by slug), whether the student has submitted
// and when the newest submission landed, read the same way the submission
// page counts them so the list never disagrees with the page behind it. One
// query per repo, keyed like the page's single-repo readers, so the cache is
// warm when the student opens a row. The record comes straight out of
// `combine`, which structurally shares its result, so the reference is stable
// while nothing resolved has changed.
export function useMySubmittedAssignments(
  org: string,
  accepted: AcceptedAssignmentRepo[],
): Readonly<Record<string, MySubmissionState>> {
  const client = useGitHubClient()

  return useQueries({
    queries: accepted.map(({ assignment, repo, defaultBranch }) =>
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
            ...myPushSubmissionsQuery(client, org, repo, defaultBranch),
            select: summarizePushes,
          },
    ),
    combine: (results) =>
      Object.fromEntries(
        accepted.map(({ assignment }, i): [string, MySubmissionState] => {
          const result = results[i]
          if (!result || result.isPending) return [assignment.slug, PENDING]
          if (result.isError || !result.data) return [assignment.slug, UNKNOWN]
          const { count, latestAt } = result.data
          return [
            assignment.slug,
            count > 0 ? { kind: "submitted", latestAt } : NONE,
          ]
        }),
      ),
  })
}

export default useMySubmittedAssignments
