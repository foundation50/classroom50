import { useMutation, useQueryClient } from "@tanstack/react-query"
import { submitAssignment, type UploadFile } from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Submit uploaded files to the student's assignment repo (the browser
// equivalent of `gh student submit`): commits a snapshot on the default branch,
// which triggers autograding. On success we invalidate the repo + releases
// queries so the submission page reflects the new HEAD and picks up the graded
// release once the background autograde run publishes it (grading is async, so
// the release won't appear on this tick — the invalidation just re-arms the
// list for the next refetch).
export function useSubmitAssignment(params: {
  org: string
  repo: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, repo, assignment } = params

  return useMutation({
    mutationFn: (files: UploadFile[]) =>
      submitAssignment({ client, org, repo, assignment, files }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.repo(org, repo),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.releases(org, repo),
      })
    },
  })
}

export default useSubmitAssignment
