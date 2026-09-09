import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { repoTagsQuery } from "@/github-core/queries"
import {
  detectTagSubmissions,
  submissionTagPatterns,
  type DetectedSubmission,
} from "@/domain/assignments/submissionDetection"
import { studentRepoName } from "@/util/studentRepo"

// The student's own tagged submissions for a tag-mode assignment, derived from
// their assignment repo's git tags. Reuses the detection primitive so the list
// matches the shim's trigger and the teacher view exactly (see
// useDetectedSubmissions). Empty until the student pushes a matching tag.
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

  const patterns = submissionTagPatterns(submissionTags)

  return useQuery({
    ...repoTagsQuery(client, org ?? "", repo),
    enabled: Boolean(org && repo),
    select: (tags): DetectedSubmission[] =>
      detectTagSubmissions(tags, patterns),
  })
}

export default useGetMyTaggedSubmissions
