// Retrofit a student repo's autograde shim to the assignment's
// submission_mode — the web twin of `gh teacher assignment submission-mode`'s
// per-repo loop. The trigger lives in each repo's workflow file (GitHub
// evaluates `on:` before any job runs), and the shim is otherwise frozen at
// accept time, so a mode change must rewrite the file in every existing repo.
//
// The rewrite is LINE SURGERY on the known trigger block, never a full
// re-render: the CLI-accept and web-accept shims share the trigger shape but
// differ in their comment headers, so re-rendering would churn repos accepted
// by the other client. Content that doesn't match a known default-shim
// trigger shape (student-edited, teacher-authored) is reported and never
// overwritten. Keep the block regex in lockstep with the Go twin
// (cli/gh-teacher/internal/assignmentcmd/submissionmode.go shimTriggerBlock).
import type { GitHubClient } from "@/github-core/client"
import {
  createCommitForAssignment,
  createTreeRepo,
  updateRefForRepo,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import { getBranchRefRepo, getCommitByRepo } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { decodeBase64Utf8 } from "@/util/github"
import { prefixCommit } from "@/util/commit"

// The shim's path in every student repo. Byte-mirror of the CLI's
// classroomcfg.AutogradeWorkflowPath and runner.py's SHIM_UPDATE_COMMIT_PATHS.
export const AUTOGRADE_SHIM_PATH = ".github/workflows/autograde.yaml"

// The retrofit commit message. The `[skip ci]` body line is load-bearing: a
// tag→every-push retrofit commit carries the restored push trigger, and this
// commit is authored with the teacher's OAuth token (user pushes DO fire
// workflows). Byte-mirror of contract.ShimUpdateCommitMessage (Go), pinned by
// TestShimUpdateCommitMessage.
export function shimUpdateCommitMessage(mode: "every-push" | "tag"): string {
  return (
    prefixCommit(`Update autograder trigger to ${mode} (submission-mode)`) +
    "\n\n[skip ci]"
  )
}

// The default shim's `on:` block in either mode: an optional branches: line
// (group 1) followed by the submit/* tags line. Mirror of the Go
// shimTriggerBlock regex.
const SHIM_TRIGGER_BLOCK =
  /^on:\n {2}push:\n( {4}branches: \[[^\n]*\]\n)? {4}tags: \["submit\/\*"\]\n/m

export type ShimRewrite =
  | { kind: "changed"; content: string }
  | { kind: "current" }
  | { kind: "unrecognized"; reason: string }

// Swap the shim's trigger block to `mode`. every-push → tag removes the
// branches: line; tag → every-push inserts it with the repo's CURRENT default
// branch (the branch pushes actually land on).
export function rewriteShimTrigger(
  content: string,
  mode: "every-push" | "tag",
  branch: string,
): ShimRewrite {
  const match = SHIM_TRIGGER_BLOCK.exec(content)
  if (!match) {
    return {
      kind: "unrecognized",
      reason: "shim does not carry a recognizable default trigger block",
    }
  }
  const hasBranches = match[1] !== undefined

  if (mode === "tag") {
    if (!hasBranches) return { kind: "current" }
    const start = match.index + "on:\n  push:\n".length
    return {
      kind: "changed",
      content: content.slice(0, start) + content.slice(start + match[1].length),
    }
  }
  // every-push: insert the branches line unless one is already present (its
  // possibly-stale branch name is accept-time behavior, not ours to correct).
  if (hasBranches) return { kind: "current" }
  const insertAt = match.index + "on:\n  push:\n".length
  const line = `    branches: ["${branch}"]\n`
  return {
    kind: "changed",
    content: content.slice(0, insertAt) + line + content.slice(insertAt),
  }
}

export type ShimUpdateOutcome =
  | { status: "updated" }
  | { status: "current" }
  | { status: "unrecognized"; reason: string }
  | { status: "notAccepted" }
  | { status: "missingWorkflowScope" }

// Update one repo's shim to `mode`, idempotently. Reads the live default
// branch (the shim is branch-specific), fetches the current shim, rewrites the
// trigger block, and commits with [skip ci]. A 404 tree write with the
// workflow scope absent from X-OAuth-Scopes is GitHub's signature for a token
// that can't touch .github/workflows/* — surfaced as its own outcome so the
// UI can show the re-auth remediation once, not per repo.
export async function updateShimSubmissionMode(params: {
  client: GitHubClient
  org: string
  repo: string
  mode: "every-push" | "tag"
}): Promise<ShimUpdateOutcome> {
  const { client, org, repo, mode } = params

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

  let current: string
  try {
    const resp = await client.request<{ content?: string; encoding?: string }>(
      `/repos/${org}/${repo}/contents/${AUTOGRADE_SHIM_PATH}?ref=${encodeURIComponent(branch)}`,
    )
    if (!resp?.content || resp.encoding !== "base64") {
      return {
        status: "unrecognized",
        reason: "unexpected contents response for the shim",
      }
    }
    current = decodeBase64Utf8(resp.content)
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      // Repo exists but the shim never landed (mid-flow accept failure);
      // accept's self-heal owns that case.
      return {
        status: "unrecognized",
        reason: "no autograde workflow — accept may not have completed",
      }
    }
    throw err
  }

  const rewrite = rewriteShimTrigger(current, mode, branch)
  if (rewrite.kind === "current") return { status: "current" }
  if (rewrite.kind === "unrecognized") {
    return { status: "unrecognized", reason: rewrite.reason }
  }

  const ref = await getBranchRefRepo(client, org, repo, branch)
  const parentSha = ref.object.sha
  const parentCommit = await getCommitByRepo(client, org, repo, parentSha)
  const baseTreeSha = parentCommit.tree?.sha
  if (!parentSha || !baseTreeSha) {
    throw new Error(`${org}/${repo}: could not resolve the branch tip`)
  }

  let tree: { sha: string }
  try {
    tree = await createTreeRepo(client, {
      base_tree: baseTreeSha,
      org,
      repo,
      tree: [
        {
          path: AUTOGRADE_SHIM_PATH,
          mode: "100644",
          type: "blob",
          content: rewrite.content,
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
  const commit = await createCommitForAssignment({
    client,
    owner: org,
    repo,
    message: shimUpdateCommitMessage(mode),
    treeSha: tree.sha,
    parentSha,
  })
  await updateRefForRepo({
    client,
    owner: org,
    repo,
    branch,
    commitSha: commit.sha,
  })
  return { status: "updated" }
}

// Whether the error's X-OAuth-Scopes header is present but missing
// `workflow`. Mirrors the Go tokenLacksWorkflowScope (configwrite): an absent
// header (fine-grained PAT) returns false so we don't guess.
function tokenLacksWorkflowScope(err: GitHubAPIError): boolean {
  const scopes = err.oauthScopes
  if (!scopes) return false
  return !scopes
    .split(",")
    .map((s) => s.trim())
    .includes("workflow")
}
