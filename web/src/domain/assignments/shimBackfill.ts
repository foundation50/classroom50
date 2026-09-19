// Add the default autograde shim to a student repo accepted while the
// assignment had the built-in autograder off (no_autograder). Accept writes the
// shim only when the autograder is on, so flipping the setting later leaves the
// already-accepted repos with no workflow and nothing ever grades them. This is
// the web twin of `gh teacher assignment enable-autograder`'s per-repo loop.
//
// A repo that already carries a default shim is reported present and never
// rewritten: the submission-mode retrofit (submissionTrigger.ts) owns
// reconciling its trigger. Any other file at the reserved path is reported
// unrecognized and left alone, since calling it present would hide that
// nothing grades. Custom (teacher-authored) autograders are gated out by the
// callers, as they are for the retrofit.
import type { GitHubClient } from "@/github-core/client"
import { readRepoHead } from "@/github-core/mutations"
import { SHIM_BACKFILL_COMMIT_MESSAGE } from "@/util/commit"
import type { SubmissionMode } from "@/types/classroom"
import { defaultAutograderWorkflow } from "./autograderYaml"
import {
  commitShimFile,
  isDefaultShim,
  readShimAtHead,
  resolveStudentRepoBranch,
} from "./submissionTrigger"

export type ShimBackfillOutcome =
  | { status: "added" }
  | { status: "present" }
  | { status: "unrecognized"; reason: string }
  | { status: "notAccepted" }
  | { status: "missingWorkflowScope" }

export async function addAutogradeShim(params: {
  client: GitHubClient
  org: string
  repo: string
  // The config repo's default branch: the reusable-workflow ref the shim
  // points at. The caller resolves it once, and fails closed rather than
  // guessing, because an existing shim is never rewritten.
  configBranch: string
  submissionMode: SubmissionMode
  submissionTags?: string[]
}): Promise<ShimBackfillOutcome> {
  const { client, org, repo, configBranch, submissionMode, submissionTags } =
    params

  const branch = await resolveStudentRepoBranch(client, org, repo)
  if (!branch) return { status: "notAccepted" }
  const head = await readRepoHead(client, { owner: org, repo }, branch)

  const current = await readShimAtHead(client, org, repo, head.headSha)
  if (current !== null) {
    if (isDefaultShim(current)) return { status: "present" }
    return {
      status: "unrecognized",
      reason:
        "a workflow already exists at the shim path but is not the default autograde shim",
    }
  }

  const content = defaultAutograderWorkflow(
    org,
    branch,
    configBranch,
    submissionMode,
    submissionTags,
  )
  const committed = await commitShimFile(
    client,
    org,
    repo,
    head,
    content,
    SHIM_BACKFILL_COMMIT_MESSAGE,
  )
  if (committed === "missingWorkflowScope") {
    return { status: "missingWorkflowScope" }
  }
  return { status: "added" }
}
