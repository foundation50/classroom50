// Add the default autograde shim to a student repo accepted while the
// assignment had the built-in autograder off (no_autograder). Accept writes the
// shim only when the autograder is on, so flipping the setting later leaves the
// already-accepted repos with no workflow and nothing ever grades them. This is
// the web twin of `gh teacher assignment enable-autograder`'s per-repo loop.
//
// A repo that already has the file is reported and never rewritten: the
// submission-mode retrofit (submissionTrigger.ts) owns reconciling an existing
// shim's trigger. Custom (teacher-authored) autograders are gated out by the
// callers, as they are for the retrofit.
import type { GitHubClient } from "@/github-core/client"
import {
  commitRepoTree,
  createRepoTree,
  readRepoHead,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import { GitHubAPIError } from "@/github-core/errors"
import { SHIM_BACKFILL_COMMIT_MESSAGE } from "@/util/commit"
import type { SubmissionMode } from "@/types/classroom"
import { defaultAutograderWorkflow } from "./autograderYaml"
import {
  AUTOGRADE_SHIM_PATH,
  tokenLacksWorkflowScope,
} from "./submissionTrigger"

export type ShimBackfillOutcome =
  | { status: "added" }
  | { status: "present" }
  | { status: "notAccepted" }
  | { status: "missingWorkflowScope" }

export async function addAutogradeShim(params: {
  client: GitHubClient
  org: string
  repo: string
  // The config repo's default branch: the reusable-workflow ref the shim
  // points at. Resolved once by the caller, not per repo.
  configBranch: string
  submissionMode: SubmissionMode
  submissionTags?: string[]
}): Promise<ShimBackfillOutcome> {
  const { client, org, repo, configBranch, submissionMode, submissionTags } =
    params

  let branch: string
  try {
    const live = await getRepo(client, org, repo)
    if (!live?.default_branch) return { status: "notAccepted" }
    branch = live.default_branch
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return { status: "notAccepted" }
    }
    throw err
  }

  // Pin the existence check and the commit to one resolved tip SHA, for the
  // same read-after-write reason as updateShimSubmissionMode.
  const head = await readRepoHead(client, { owner: org, repo }, branch)

  try {
    await client.request(
      `/repos/${org}/${repo}/contents/${AUTOGRADE_SHIM_PATH}?ref=${encodeURIComponent(head.headSha)}`,
    )
    return { status: "present" }
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.status === 404)) throw err
  }

  const content = defaultAutograderWorkflow(
    org,
    branch,
    configBranch,
    submissionMode,
    submissionTags,
  )

  // Only the tree POST is classified: it is the call GitHub rejects with a
  // 404 when the token lacks the `workflow` scope needed to touch a workflow
  // file.
  let tree: { sha: string }
  try {
    tree = await createRepoTree(client, {
      owner: org,
      repo,
      baseTreeSha: head.baseTreeSha,
      tree: [
        {
          path: AUTOGRADE_SHIM_PATH,
          mode: "100644",
          type: "blob",
          content,
        },
      ],
    })
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      err.status === 404 &&
      tokenLacksWorkflowScope(err)
    ) {
      return { status: "missingWorkflowScope" }
    }
    throw err
  }
  await commitRepoTree(
    client,
    { owner: org, repo },
    head,
    tree.sha,
    SHIM_BACKFILL_COMMIT_MESSAGE,
  )
  return { status: "added" }
}
