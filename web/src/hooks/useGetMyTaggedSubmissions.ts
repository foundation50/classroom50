import { queryOptions, useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { GitHubClient } from "@/github-core/client"
import { repoTagsQuery } from "@/github-core/queries"
import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"
import {
  detectTagSubmissions,
  type DetectedSubmission,
} from "@/domain/assignments/submissionDetection"
import { studentRepoName } from "@/util/studentRepo"

// Query options for one repo's tagged submissions, shared by the single-repo
// hook below and the student list's per-assignment fan-out (one cache entry
// per repo, keyed on the raw tag list). Unions the milestone patterns with
// submit/* so a plain tag-mode assignment (no milestone patterns — students
// push submit/* via `gh student submit`) still surfaces its submissions.
export const myTaggedSubmissionsQuery = (
  client: GitHubClient,
  org: string,
  repo: string,
  submissionTags?: string[],
) => {
  const patterns = [...(submissionTags ?? []), `${SUBMISSION_TAG_PREFIX}*`]
  return queryOptions({
    ...repoTagsQuery(client, org, repo),
    select: (tags): DetectedSubmission[] =>
      detectTagSubmissions(tags, patterns),
  })
}

// The student's own tagged submissions for a tag-mode assignment, derived from
// their assignment repo's git tags. Reuses the detection primitive so the list
// matches the shim's trigger and the teacher view exactly: the configured
// milestone patterns unioned with the always-on canonical submit/* namespace
// (see useDetectedSubmissions). Empty until the student pushes a matching tag.
const useGetMyTaggedSubmissions = (
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  username: string | undefined,
  submissionTags?: string[],
) => {
  const client = useGitHubClient()

  const repo =
    classroom && assignment && username
      ? studentRepoName(classroom, assignment, username)
      : ""

  return useQuery(
    myTaggedSubmissionsQuery(client, org ?? "", repo, submissionTags),
  )
}

export default useGetMyTaggedSubmissions
