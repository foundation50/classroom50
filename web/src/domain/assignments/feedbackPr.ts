import type { GitHubClient } from "@/github-core/client"
import type { AssignmentMode } from "@/types/classroom"
import {
  listPullRequestsByBaseHead,
  createPullRequest,
  createBranchRef,
  ensureRepoLabel,
  addIssueLabels,
  is422NoCommitsBetween,
  createCommitForAssignment,
  updateRefForRepo,
} from "@/github-core/mutations"
import { getBranchRefRepo, getCommitByRepo } from "@/github-core/queries"
import { prefixCommit } from "@/util/commit"
import { logger } from "@/lib/logger"

const log = logger.scope("assignments:feedbackPr")

// ---------------------------------------------------------------------------
// Cross-language contract constants. Kept byte-identical, with NO compile-time
// link, to cli/shared/contract/contract.go (FeedbackBaseBranch, FeedbackPRTitle,
// FeedbackOpenCommitMessage, FeedbackLabelForMode, FeedbackPRBody) and the
// runner's ensure_feedback_pr.py (BASE_BRANCH, --title, _LABELS, pr_body) —
// update every copy in lockstep. The runner adopts the accept-time PR purely by
// base+head branch, so these names/strings decide whether teachers see ONE
// coherent Feedback PR or two competing ones.
// ---------------------------------------------------------------------------

// The frozen PR base, pinned at the accept commit. Also baked into the
// `classroom50-feedback-base-lock` org ruleset gh teacher init deploys.
export const FEEDBACK_BASE_BRANCH = "feedback"

export const FEEDBACK_PR_TITLE = "Feedback"

// The empty commit that gives the zero-diff accept-time PR a commit to exist
// on. `[skip ci]` is load-bearing: it keeps the autograde shim from running
// on a commit with nothing to grade.
export const FEEDBACK_OPEN_COMMIT_MESSAGE = `${prefixCommit(
  "Open Feedback PR (gh student accept)",
)}\n\n[skip ci]`

// Mode label + pinned color, mirroring GitHub Classroom's Individual/Group
// feedback labels (ensure_feedback_pr.py _LABELS). Unknown -> individual.
export function feedbackLabelForMode(mode: AssignmentMode | string): {
  name: string
  color: string
} {
  if ((mode ?? "").trim().toLowerCase() === "group") {
    return { name: "Group Assignment", color: "5319E7" }
  }
  return { name: "Individual Assignment", color: "0E8A16" }
}

// The PR body, byte-identical with ensure_feedback_pr.py's pr_body(head,
// release_url) output. It MUST contain releaseUrl: the runner's
// backfill_release_link() rewrites any open Feedback PR whose body lacks the
// `.../releases/latest` link, so omitting it here would get this body
// clobbered on the first submission.
export function feedbackPrBody(head: string, releaseUrl: string): string {
  return [
    ":wave:! Classroom 50 opened this pull request as a place for your " +
      "teacher to leave feedback on your work. It updates automatically. " +
      "**Don't close or merge this pull request** unless your teacher tells you to.",
    "",
    "Each commit is automatically graded — the latest autograding result " +
      `is [here](${releaseUrl}).`,
    "",
    "Your teacher can leave comments and feedback on your code here. Click " +
      "the **Subscribe** button to be notified when that happens.",
    "",
    "Open the **Files changed** or **Commits** tab to see everything " +
      `you've pushed to \`${head}\` since you accepted the assignment — your ` +
      "teacher sees the same view.",
    "",
    "<details>",
    "<summary><strong>Notes for teachers</strong></summary>",
    "",
    "Use this PR to leave feedback:",
    "",
    `- **Files changed** shows the full diff on \`${head}\` since the student ` +
      "accepted. Hover a line and click the blue **+** to leave a line comment.",
    "- **Commits** lists each pushed commit; open one to see its changes.",
    "- Autograde results appear as the `classroom50/autograde` commit " +
      "status / check on each submission.",
    `- The [latest autograding result](${releaseUrl}) has the per-test ` +
      "detail behind that status.",
    "- This page is an overview — commits, line comments, and a general " +
      "comment box below.",
    "",
    `The base branch (\`${FEEDBACK_BASE_BRANCH}\`) is frozen at the starter so the diff ` +
      "always reflects the full body of work. The PR is managed automatically " +
      "by the autograde runner; merging it is the teacher-side " +
      '"grading done" signal.',
    "</details>",
  ].join("\n")
}

export type EnsureFeedbackPrResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: string }

// Open the assignment's Feedback PR at accept time (issue #228): base = the
// frozen `feedback` branch at the accept commit, head = the repo's settled
// default branch. Creating it here — with the student's own token — means the
// PR exists even when GitHub Actions is disabled; when Actions IS on, the
// autograde runner (ensure_feedback_pr.py) discovers the PR by base+head and
// adopts it instead of creating its own.
//
// Best-effort BY CONTRACT: never throws. Any failure resolves {ok: false} for
// the caller to warn on — a classroom bootstrapped by an older gh teacher
// init (no feedback-base ruleset), a permissions oddity, or a race with an
// instant first push must not fail the accept. The runner remains the
// fallback creator on the first submission.
//
// Idempotent: a PR in ANY state (open/closed/merged) short-circuits before
// any write, so a re-accept never duplicates the PR or its empty commit, and
// never reopens a PR a teacher or the runner has since closed/merged.
//
// Mirrors the CLI's ensureFeedbackPullRequest (cli/gh-student/feedback_pr.go)
// — keep behavior in lockstep.
export async function ensureFeedbackPullRequest(params: {
  client: GitHubClient
  owner: string
  repo: string
  // The repo's SETTLED default branch (may be `master`) — the branch the
  // accept commit actually landed on, not a pre-guessed `main`.
  branch: string
  acceptCommitSha: string
  mode: AssignmentMode | string
}): Promise<EnsureFeedbackPrResult> {
  const { client, owner, repo, branch, acceptCommitSha, mode } = params

  try {
    const existing = await listPullRequestsByBaseHead({
      client,
      owner,
      repo,
      base: FEEDBACK_BASE_BRANCH,
      head: branch,
    })
    if (existing.length > 0) {
      log.info("feedback PR already exists; leaving as-is", { owner, repo })
      return { ok: true, created: false }
    }

    // Freeze the base at the accept commit — the same baseline the runner
    // resolves from the .classroom50.yaml marker, so its base-SHA check
    // adopts this branch as its own. Already-exists resolves false (healthy
    // re-run, or the runner got there first) and is fine.
    await createBranchRef({
      client,
      owner,
      repo,
      branch: FEEDBACK_BASE_BRANCH,
      sha: acceptCommitSha,
    })

    const releaseUrl = `https://github.com/${owner}/${repo}/releases/latest`
    const create = () =>
      createPullRequest({
        client,
        owner,
        repo,
        base: FEEDBACK_BASE_BRANCH,
        head: branch,
        title: FEEDBACK_PR_TITLE,
        body: feedbackPrBody(branch, releaseUrl),
      })

    let pr
    try {
      // PR-first, empty commit on demand: if a prior interrupted accept
      // already landed the empty commit but died before the PR, this first
      // POST succeeds and no second empty commit is pushed.
      pr = await create()
    } catch (err) {
      if (!is422NoCommitsBetween(err)) throw err
      // Zero diff at accept time is the normal case: GitHub refuses a PR
      // with no commits between base and head, so land one empty commit
      // (same tree; `[skip ci]` keeps the shim quiet) and retry once.
      await pushEmptyCommit({ client, owner, repo, branch })
      pr = await create()
    }

    // Label best-effort (mirrors the runner's check=False label step): the
    // PR is in place, so a label failure is log-level, not a step failure.
    try {
      const label = feedbackLabelForMode(mode)
      await ensureRepoLabel({
        client,
        owner,
        repo,
        name: label.name,
        color: label.color,
        description: "Classroom 50 teacher-managed feedback PR",
      })
      await addIssueLabels({
        client,
        owner,
        repo,
        issueNumber: pr.number,
        labels: [label.name],
      })
    } catch (err) {
      log.warn("could not label feedback PR (non-fatal)", { owner, repo, err })
    }

    log.info("feedback PR created at accept time", {
      owner,
      repo,
      number: pr.number,
    })
    return { ok: true, created: true }
  } catch (err) {
    log.warn("could not open feedback PR at accept time (non-fatal)", {
      owner,
      repo,
      err,
    })
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Unexpected error",
    }
  }
}

// Fast-forward `branch` by one empty commit (same tree as the current head)
// so a zero-diff Feedback PR has a commit to exist on. force stays false:
// losing the ref race to a student's instant first push means the runner will
// open the PR on that submission instead — overwriting their work is never
// acceptable.
async function pushEmptyCommit(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
}) {
  const { client, owner, repo, branch } = params
  const ref = await getBranchRefRepo(client, owner, repo, branch)
  const headSha = ref.object.sha
  const head = await getCommitByRepo(client, owner, repo, headSha)
  const commit = await createCommitForAssignment({
    client,
    owner,
    repo,
    message: FEEDBACK_OPEN_COMMIT_MESSAGE,
    treeSha: head.tree.sha,
    parentSha: headSha,
  })
  await updateRefForRepo({
    client,
    owner,
    repo,
    branch,
    commitSha: commit.sha,
  })
}
