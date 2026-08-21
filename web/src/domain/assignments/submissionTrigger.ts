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
import { shimUpdateCommitMessage } from "@/util/commit"
import { safeShimTagPatterns } from "@/util/submissionTags"

// The shim's path in every student repo. Byte-mirror of the CLI's
// classroomcfg.AutogradeWorkflowPath and runner.py's SHIM_UPDATE_COMMIT_PATHS.
export const AUTOGRADE_SHIM_PATH = ".github/workflows/autograde.yaml"

// The default shim's `on:` block in any mode/tags combination: an optional
// branches: line (group 1) followed by the tags line (group 2 — the default
// `["submit/*"]` or a milestone-pattern union). Mirror of the Go
// shimTriggerBlock regex.
const SHIM_TRIGGER_BLOCK =
  /^on:\n {2}push:\n( {4}branches: \[[^\n]*\]\n)?( {4}tags: \[[^\n]*\]\n)/m

export type ShimRewrite =
  | { kind: "changed"; content: string }
  | { kind: "current" }
  | { kind: "unrecognized"; reason: string }

// The shim's tags flow sequence: the milestone patterns (if any) union the
// always-on submit/* namespace. Byte-format mirror of Go
// contract.ShimTagsList and autograderYaml.ts's shimTagsList. FAIL CLOSED:
// the retrofit writes workflow files into student repos with the teacher's
// OAuth token from the (hand-editable) manifest, so unsafe patterns drop the
// whole milestone set (see safeShimTagPatterns).
function shimTagsList(tags: string[]): string {
  return [...safeShimTagPatterns(tags), "submit/*"]
    .map((p) => `"${p}"`)
    .join(", ")
}

// Swap the shim's trigger block to `mode` + `tags`. every-push → tag removes
// the branches: line; tag → every-push inserts it with the repo's CURRENT
// default branch (the branch pushes actually land on; an existing line is
// kept verbatim for the same reason). The tags line is reconciled to the
// union of the assignment's milestone patterns and submit/*, so the same
// retrofit that flips the mode also repairs a stale pattern set.
export function rewriteShimTrigger(
  content: string,
  mode: "every-push" | "tag",
  branch: string,
  tags: string[] = [],
): ShimRewrite {
  const match = SHIM_TRIGGER_BLOCK.exec(content)
  if (!match) {
    return {
      kind: "unrecognized",
      reason: "shim does not carry a recognizable default trigger block",
    }
  }
  const existingBranches = match[1]

  let branchesLine = ""
  if (mode === "every-push") {
    // Keep an existing line verbatim: its (possibly stale) branch name is
    // accept-time behavior, not this action's to correct.
    branchesLine = existingBranches ?? `    branches: ["${branch}"]\n`
  }
  const tagsLine = `    tags: [${shimTagsList(tags)}]\n`

  const rebuilt =
    content.slice(0, match.index) +
    "on:\n  push:\n" +
    branchesLine +
    tagsLine +
    content.slice(match.index + match[0].length)
  return rebuilt === content
    ? { kind: "current" }
    : { kind: "changed", content: rebuilt }
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
  // The assignment's milestone submission_tags; the rewrite reconciles the
  // shim's tags line to their union with submit/*. Omit for none.
  tags?: string[]
}): Promise<ShimUpdateOutcome> {
  const { client, org, repo, mode, tags } = params

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

  // Pin the whole read-rewrite-commit cycle to one resolved tip SHA. Reading
  // the shim at the branch NAME can lag a just-landed write (GitHub
  // read-after-write lag — the misreport the Go retrofitShim fixed, observed
  // live 2026-08-05), which would rewrite from stale content or misreport
  // "current"; reading at the same SHA the commit builds on keeps the no-op
  // check and the write consistent.
  const ref = await getBranchRefRepo(client, org, repo, branch)
  const parentSha = ref.object.sha
  const parentCommit = await getCommitByRepo(client, org, repo, parentSha)
  const baseTreeSha = parentCommit.tree?.sha
  if (!parentSha || !baseTreeSha) {
    throw new Error(`${org}/${repo}: could not resolve the branch tip`)
  }

  let current: string
  try {
    const resp = await client.request<{ content?: string; encoding?: string }>(
      `/repos/${org}/${repo}/contents/${AUTOGRADE_SHIM_PATH}?ref=${encodeURIComponent(parentSha)}`,
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

  const rewrite = rewriteShimTrigger(current, mode, branch, tags ?? [])
  if (rewrite.kind === "current") return { status: "current" }
  if (rewrite.kind === "unrecognized") {
    return { status: "unrecognized", reason: rewrite.reason }
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
