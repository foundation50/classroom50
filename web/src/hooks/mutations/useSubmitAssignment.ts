import { useMutation, useQueryClient } from "@tanstack/react-query"
import { submitAssignment, type UploadFile } from "@/domain/assignments"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { SubmissionMode } from "@/types/classroom"

// Submit uploaded files to the student's assignment repo (the browser
// equivalent of `gh student submit`): commits a snapshot on the default branch,
// which triggers autograding. We invalidate the repo + releases queries so the
// submission page reflects the new HEAD and picks up the graded release once
// the background autograde run publishes it (grading is async, so the release
// won't appear on this tick — the invalidation just re-arms the list for the
// next refetch). Invalidation runs on settled, not success: a tag-mode submit
// can fail AFTER the branch commit landed (the tag push is a separate write),
// and the page must still reflect the new HEAD in that case.
export function useSubmitAssignment(params: {
  org: string
  repo: string
  assignment: string
  // The assignment's submission_mode; "tag" makes submit also push the
  // submit/* tag that triggers grading (branch pushes alone don't grade).
  submissionMode?: SubmissionMode
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, repo, assignment, submissionMode } = params

  return useMutation({
    mutationFn: (files: UploadFile[]) =>
      submitAssignment({
        client,
        org,
        repo,
        assignment,
        files,
        submissionMode,
      }),
    onSettled: () => {
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
