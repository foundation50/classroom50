import { useQueries } from "@tanstack/react-query"
import { useMemo } from "react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { resolveSubmissionMode } from "@/domain/assignments/submissionDetection"
import { myPushSubmissionsQuery } from "@/hooks/useGetMyPushSubmissions"
import { myTaggedSubmissionsQuery } from "@/hooks/useGetMyTaggedSubmissions"
import type { Assignment } from "@/types/classroom"

// An assignment the student accepted, with the repo that acceptance resolved
// to: their own `<classroom>-<slug>-<login>`, or the group's
// `<classroom>-<slug>-group-<n>` in team mode.
export type AcceptedAssignmentRepo = {
  assignment: Assignment
  repo: string
}

// Which of the student's accepted assignments have at least one submission,
// read the same way the submission page counts them (push commits past the
// baseline in every-push mode, submit/* or milestone tags in tag mode) so the
// list's "Submitted" badge never disagrees with the page behind it. One query
// per accepted repo through the shared single-repo option factories, so the
// cache is warm when the student opens a row. A repo whose read fails settles
// as not submitted: the row falls back to "Accepted", which is still true.
export function useMySubmittedAssignments(
  org: string,
  accepted: AcceptedAssignmentRepo[],
): { submittedSlugs: ReadonlySet<string>; isPending: boolean } {
  const client = useGitHubClient()

  const { signature, isPending } = useQueries({
    queries: accepted.map(({ assignment, repo }) =>
      resolveSubmissionMode(assignment.submission_mode) === "tag"
        ? myTaggedSubmissionsQuery(
            client,
            org,
            repo,
            assignment.submission_tags,
          )
        : myPushSubmissionsQuery(client, org, repo),
    ),
    combine: (results) => ({
      // A string signature rather than a Set so the memo below hands callers
      // a stable reference while the resolved values haven't changed.
      signature: accepted
        .filter((_, i) => (results[i]?.data?.length ?? 0) > 0)
        .map((a) => a.assignment.slug)
        .join("\n"),
      isPending: results.some((r) => r.isPending),
    }),
  })

  const submittedSlugs = useMemo(
    () => new Set(signature ? signature.split("\n") : []),
    [signature],
  )

  return { submittedSlugs, isPending }
}

export default useMySubmittedAssignments
