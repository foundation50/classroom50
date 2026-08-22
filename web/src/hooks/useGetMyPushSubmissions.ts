import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  githubKeys,
  getOldestCommitShaForPath,
  listDefaultBranchCommits,
} from "@/github-core/queries"
import { getRepo } from "@/github-core/repoReads"
import type { GitHubCommit } from "@/github-core/types"
import { submissionCommits } from "@/domain/assignments/submissionDetection"
import { studentRepoName } from "@/util/studentRepo"

// The student's own push submissions for an every-push assignment: the
// default-branch commits that count as submissions (submissionCommits — the
// baseline and the tool's own bookkeeping commits excluded), newest first.
// Shares that filter with useDetectedSubmissions' branch path, for a single
// repo, so the student sees the same submissions the teacher counts. Empty
// until the first real push. Disabled unless org+repo resolve, so a tag-mode
// page (which doesn't call this) costs no read.
const useGetMyPushSubmissions = (
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
    queryKey: [...githubKeys.all, "my-push-submissions", org ?? "", repo],
    queryFn: async (): Promise<GitHubCommit[]> => {
      const info = await getRepo(client, org!, repo)
      const branch = info?.default_branch
      if (!branch) return [] // not accepted / commitless
      const baseline = await getOldestCommitShaForPath(
        client,
        org!,
        repo,
        ".classroom50.yaml",
      )
      const commits = await listDefaultBranchCommits(client, org!, repo, branch)
      return submissionCommits(commits, baseline)
    },
    enabled: Boolean(org && repo),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export default useGetMyPushSubmissions
