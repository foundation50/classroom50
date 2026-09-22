import { queryOptions, useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { GitHubClient } from "@/github-core/client"
import { githubKeys, readBranchSubmissionLog } from "@/github-core/queries"
import { getRepo } from "@/github-core/repoReads"
import type { GitHubCommit } from "@/github-core/types"
import { submissionCommits } from "@/domain/assignments/submissionDetection"
import { studentRepoName } from "@/util/studentRepo"

export type MyPushSubmissionsOptions = {
  // A caller that already holds the repo's default branch (the list, from
  // the org repo walk) passes it to skip the opening getRepo.
  knownDefaultBranch?: string
  // Whether the root commit is the baseline when no marker anchors one: true
  // for every initialized repo (its root is the seed), false only for a bare
  // empty_repo, whose root commit is the student's first push. Defaults to
  // true so the list and the page share one cache entry without both having
  // to state it. See BranchSubmissionLogOptions.
  rootIsBaseline?: boolean
}

// Query options for one repo's push submissions, shared by the single-repo
// hook below and the student list's per-assignment fan-out so both hit one
// cache entry: opening a row from the list finds its submissions already read.
// The key ignores knownDefaultBranch (a read shortcut, not a different result),
// so the two callers still share the entry.
export const myPushSubmissionsQuery = (
  client: GitHubClient,
  org: string,
  repo: string,
  options: MyPushSubmissionsOptions = {},
) => {
  const { knownDefaultBranch, rootIsBaseline = true } = options
  return queryOptions({
    queryKey: [
      ...githubKeys.all,
      "my-push-submissions",
      org,
      repo,
      rootIsBaseline,
    ],
    queryFn: async (): Promise<GitHubCommit[]> => {
      const branch =
        knownDefaultBranch ?? (await getRepo(client, org, repo))?.default_branch
      if (!branch) return [] // not accepted
      const { commits, baselineSha } = await readBranchSubmissionLog(
        client,
        org,
        repo,
        branch,
        { rootIsBaseline },
      )
      return submissionCommits(commits, baselineSha)
    },
    enabled: Boolean(org && repo),
    staleTime: 60 * 1000,
    retry: false,
  })
}

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
  options: Pick<MyPushSubmissionsOptions, "rootIsBaseline"> = {},
) => {
  const client = useGitHubClient()

  const repo =
    classroom && assignment && username
      ? studentRepoName(classroom, assignment, username)
      : ""

  return useQuery(myPushSubmissionsQuery(client, org ?? "", repo, options))
}

export default useGetMyPushSubmissions
