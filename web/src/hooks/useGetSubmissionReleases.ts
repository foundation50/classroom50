import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { releasesQuery } from "@/github-core/queries"
import { studentRepoName } from "@/util/studentRepo"

// The student's graded-submission releases (`submit/*` tags) for an assignment,
// newest first. Each release page renders the score + per-test table, so the
// student page links straight to them. Empty until the first release.
const useGetSubmissionReleases = (
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  username: string | undefined,
) => {
  const client = useGitHubClient()

  const repo =
    classroom && assignment && username
      ? studentRepoName(classroom, assignment, username)
      : ""

  return useQuery({
    ...releasesQuery(client, org ?? "", repo),
    enabled: Boolean(org && repo),
  })
}

export default useGetSubmissionReleases
