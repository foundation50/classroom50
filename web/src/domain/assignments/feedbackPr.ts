import type { GitHubClient } from "@/github-core/client"
import {
  createPullRequest,
  createBranchRef,
  ensureRepoLabel,
  addIssueLabels,
  createCommitForAssignment,
  updateRefForRepo,
} from "@/github-core/mutations"
import { is422NoCommitsBetween } from "@/github-core/errors"
import {
  getBranchRefRepo,
  getCommitByRepo,
  getOldestCommitShaForPath,
  isFreshRepoLagError,
  listPullRequestsByBaseHead,
  withFreshRepoRetry,
  REPO_READ_CONCURRENCY,
} from "@/github-core/queries"
import { getRepo } from "@/github-core/repoReads"
import type { AssignmentMode } from "@/types/classroom"
import { mapWithConcurrency } from "@/util/concurrency"
import { prefixCommit } from "@/util/commit"
import { FEEDBACK_BASE_BRANCH } from "@/util/feedbackPr"
import { logger } from "@/lib/logger"
// The single canonical Feedback PR body source, shared with the Go contract
// (cli/shared/contract/feedbackPrBody.md, embedded there) and the Python runner
// (mirrored). Imported as raw text; feedbackPrBody substitutes the placeholder
// tokens. The cross-language golden pins all three copies (feedbackPr.test.ts).
import feedbackPrBodyTemplate from "../../../../cli/shared/contract/feedbackPrBody.md?raw"

const log = logger.scope("assignments:feedbackPr")

// ---------------------------------------------------------------------------
// Cross-language contract constants. Kept byte-identical, with NO compile-time
// link, to cli/shared/contract/contract.go (FeedbackPRTitle,
// FeedbackOpenCommitMessage, FeedbackLabelForMode, FeedbackPRBody) and the
// runner's ensure_feedback_pr.py (--title, _LABELS, pr_body) — update every
// copy in lockstep. The runner adopts the accept-time PR purely by base+head
// branch, so these strings decide whether teachers see ONE coherent Feedback PR
// or two competing ones. FEEDBACK_BASE_BRANCH lives in @/util/feedbackPr
// because github-core's ruleset code locks the same branch name.
// ---------------------------------------------------------------------------

export const FEEDBACK_PR_TITLE = "Feedback"

// `[skip ci]` is load-bearing: it keeps the autograde shim from running on a
// commit with nothing to grade.
export const FEEDBACK_OPEN_COMMIT_MESSAGE = `${prefixCommit(
  "Open Feedback PR (gh student accept)",
)}\n\n[skip ci]`

// Mode label + pinned color, mirroring GitHub Classroom's Individual/Group
// feedback labels. Unknown -> individual.
export function feedbackLabelForMode(mode: string): {
  name: string
  color: string
} {
  if (mode.trim().toLowerCase() === "group") {
    return { name: "Group Assignment", color: "5319E7" }
  }
  return { name: "Individual Assignment", color: "0E8A16" }
}

// Renders the built-in Feedback PR body from the canonical feedbackPrBody.md by
// substituting the head branch, the static release URL, and the frozen base.
// Byte-identical with the Go (FeedbackPRBody) and Python (pr_body) copies,
// pinned by the cross-language golden. releaseUrl is the static
// `.../releases/latest` pointer; once written at creation it self-updates.
export function feedbackPrBody(head: string, releaseUrl: string): string {
  return feedbackPrBodyTemplate
    .replaceAll("HEAD_BRANCH", head)
    .replaceAll("RELEASE_URL", releaseUrl)
    .replaceAll("BASE_BRANCH", FEEDBACK_BASE_BRANCH)
}

// A stable, non-message reason for an ensure/repair failure, so callers can
// classify without parsing English:
//   base-mismatch  the `feedback` branch is frozen at the wrong SHA — NEVER
//                  retryable; only an org admin deleting the branch fixes it.
//   transient      anything else (a GitHub outage, rate limit, or git-data
//                  lag) — retryable, so re-running can recover it.
export type FeedbackPrFailureCode = "base-mismatch" | "transient"

export type EnsureFeedbackPrResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: string; code: FeedbackPrFailureCode }

// The frozen base doesn't point where it must. Never retried: unlike git-data
// lag this can't resolve itself, and only an org admin deleting the branch fixes
// it.
class FeedbackBaseMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeedbackBaseMismatchError"
  }
}

// Bounded so a best-effort step can't stall the accept checklist: 3 attempts at
// 300ms/600ms (vs the accept commit's longer budget, which the accept genuinely
// depends on).
const FEEDBACK_PR_RETRY = {
  attempts: 3,
  baseDelayMs: 300,
  shouldRetry: (err: unknown) =>
    !(err instanceof FeedbackBaseMismatchError) && isFreshRepoLagError(err),
}

// Native GitHub pull request template paths, probed in this order — mirrors
// the runner (ensure_feedback_pr.py) and the student CLI.
const TEMPLATE_PR_BODY_PATHS = [
  ".github/pull_request_template.md",
  "pull_request_template.md",
  "docs/pull_request_template.md",
] as const

// Cap the read so an oversized file can't overflow GitHub's PR-body ceiling
// (~65_536 chars); over-limit falls back to the built-in body, like a miss.
// Byte-based (UTF-8), matching the Go/Python readers so every creator accepts
// or rejects the same file — a char-based cap would diverge on multibyte text.
const TEMPLATE_PR_BODY_MAX_BYTES = 60_000

// The teacher-supplied Feedback PR body from the template repo, or null.
// Reads the first existing native pull_request_template.md path VERBATIM (no
// placeholder substitution). Best-effort: a missing/empty-after-trim/oversized
// file or any read error (403 on a private template, 404, transient) returns
// null so the caller falls back to the built-in body. Used at accept time when
// the assignment set feedback_pr_template.
export async function readTemplatePrBody(
  client: GitHubClient,
  templateOwner: string,
  templateRepo: string,
  templateBranch: string,
): Promise<string | null> {
  if (!(templateOwner && templateRepo && templateBranch)) return null
  for (const path of TEMPLATE_PR_BODY_PATHS) {
    try {
      const ref = encodeURIComponent(templateBranch)
      const content = await client.requestRaw(
        `/repos/${encodeURIComponent(templateOwner)}/${encodeURIComponent(
          templateRepo,
        )}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
      )
      if (typeof content !== "string" || !content.trim()) continue
      if (
        new TextEncoder().encode(content).length > TEMPLATE_PR_BODY_MAX_BYTES
      ) {
        log.warn("feedback PR template exceeds size cap; using built-in body", {
          templateOwner,
          templateRepo,
          path,
        })
        return null
      }
      return content
    } catch {
      // 404 (no such path), 403 (private/lost read), or transient — try the
      // next path, then fall back to the built-in body. Never throws.
      continue
    }
  }
  return null
}

// The repo/branch of the assignment's template, passed at accept time when the
// assignment opts the Feedback PR body into the template's pull_request_template.md.
export type FeedbackPrTemplateRef = {
  owner: string
  repo: string
  branch: string
}

type EnsureFeedbackPrParams = {
  client: GitHubClient
  owner: string
  repo: string
  // The repo's SETTLED default branch (may be `master`) — the branch the
  // accept commit actually landed on, not a pre-guessed `main`.
  branch: string
  acceptCommitSha: string
  mode: string
  // When set (feedback_pr_template opt-in + a template), the PR body is read
  // verbatim from this template repo's pull_request_template.md, best-effort;
  // absent or a failed read falls back to the built-in body.
  feedbackPrTemplate?: FeedbackPrTemplateRef
}

// Open the assignment's Feedback PR at accept time (issue #228): base = the
// frozen `feedback` branch at the accept commit, head = the repo's settled
// default branch. Creating it here — with the student's own token — means the
// PR exists even when GitHub Actions is disabled; when Actions IS on, the
// autograde runner (ensure_feedback_pr.py) discovers the PR by base+head and
// adopts it instead of creating its own.
//
// Best-effort BY CONTRACT: never throws. Any failure resolves {ok: false} for
// the caller to warn on, retrying the whole idempotent sequence through
// GitHub's post-create git-data lag first (the same window the accept commit
// itself rides out).
//
// Mirrors the CLI's ensureFeedbackPullRequest (cli/gh-student/feedback_pr.go)
// — keep behavior in lockstep.
export async function ensureFeedbackPullRequest(
  params: EnsureFeedbackPrParams,
): Promise<EnsureFeedbackPrResult> {
  const { owner, repo } = params

  try {
    // The ensure is idempotent (an existing PR short-circuits before any write;
    // the base ref tolerates already-exists at the right SHA), so retrying a
    // partial run is safe — and without it one transient 404/409 leaves no PR
    // at all, which in an Actions-disabled classroom is permanent.
    return await withFreshRepoRetry(() => ensureOnce(params), FEEDBACK_PR_RETRY)
  } catch (err) {
    log.warn("could not open feedback PR at accept time (non-fatal)", {
      owner,
      repo,
      err,
    })
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Unexpected error",
      code:
        err instanceof FeedbackBaseMismatchError
          ? "base-mismatch"
          : "transient",
    }
  }
}

async function ensureOnce(
  params: EnsureFeedbackPrParams,
): Promise<EnsureFeedbackPrResult> {
  const { client, owner, repo, branch, acceptCommitSha, mode } = params
  const feedbackPrTemplate = params.feedbackPrTemplate

  if (await feedbackPrExists({ client, owner, repo, branch })) {
    log.info("feedback PR already exists; leaving as-is", { owner, repo })
    return { ok: true, created: false }
  }

  // Freeze the base at the accept commit — the same baseline the runner
  // resolves from the .classroom50.yaml marker, so its base-SHA check adopts
  // this branch as its own.
  const created = await createBranchRef({
    client,
    owner,
    repo,
    branch: FEEDBACK_BASE_BRANCH,
    sha: acceptCommitSha,
  })
  if (!created) {
    // An existing ref is only adopted once it READS BACK at the accept commit.
    // The org ruleset locks updates and deletion but leaves creation open, so a
    // student can pre-create `feedback` at their finished HEAD; opening the PR
    // there would show the teacher an empty grading diff. Throwing defers to
    // the runner, which refuses the same case and reports it as a failing
    // status an org admin can act on.
    const ref = await getBranchRefRepo(
      client,
      owner,
      repo,
      FEEDBACK_BASE_BRANCH,
    )
    if (ref.object.sha !== acceptCommitSha) {
      throw new FeedbackBaseMismatchError(
        `${FEEDBACK_BASE_BRANCH} branch is at ${ref.object.sha}, not the expected baseline ${acceptCommitSha} — an org admin must delete it so it can be re-frozen correctly`,
      )
    }
  }

  const releaseUrl = `https://github.com/${owner}/${repo}/releases/latest`
  // Honor feedback_pr_template: use the template repo's pull_request_template.md
  // verbatim when the assignment opted in and the file is readable, else the
  // built-in body. Best-effort — readTemplatePrBody never throws.
  const teacherBody = feedbackPrTemplate
    ? await readTemplatePrBody(
        client,
        feedbackPrTemplate.owner,
        feedbackPrTemplate.repo,
        feedbackPrTemplate.branch,
      )
    : null
  const body = teacherBody ?? feedbackPrBody(branch, releaseUrl)
  const create = () =>
    createPullRequest({
      client,
      owner,
      repo,
      base: FEEDBACK_BASE_BRANCH,
      head: branch,
      title: FEEDBACK_PR_TITLE,
      body,
    })

  let pr
  try {
    // PR-first, empty commit on demand: if a prior interrupted accept
    // already landed the empty commit but died before the PR, this first
    // POST succeeds and no second empty commit is pushed.
    pr = await create()
  } catch (err) {
    if (!is422NoCommitsBetween(err)) {
      return await raceOrThrow({ client, owner, repo, branch }, err)
    }
    // Zero diff at accept time is the normal case: GitHub refuses a PR
    // with no commits between base and head, so land one empty commit
    // (same tree; `[skip ci]` keeps the shim quiet) and retry once.
    await pushEmptyCommit({ client, owner, repo, branch })
    try {
      pr = await create()
    } catch (retryErr) {
      return await raceOrThrow({ client, owner, repo, branch }, retryErr)
    }
  }

  // Label best-effort (mirrors the runner's check=False label step): the PR
  // is in place, so a label failure is log-level, not a step failure.
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
}

// A PR in ANY state (open/closed/merged) counts, so a re-accept never
// duplicates the PR or its empty commit and never reopens one a teacher or the
// runner has since closed or merged.
async function feedbackPrExists(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
}): Promise<boolean> {
  const existing = await listPullRequestsByBaseHead({
    ...params,
    base: FEEDBACK_BASE_BRANCH,
    head: params.branch,
  })
  return existing.length > 0
}

// Swallow a create failure when the PR turns out to exist after all. Two
// concurrent accepts (group members, or a re-accept racing the runner) can both
// pass the existence probe; the loser gets GitHub's "A pull request already
// exists" 422 and would otherwise tell the student nothing was opened. Mirrors
// the runner's existing_pr_url re-query. The original error is rethrown when
// the re-query finds nothing, so a genuine failure is never masked.
async function raceOrThrow(
  params: {
    client: GitHubClient
    owner: string
    repo: string
    branch: string
  },
  createErr: unknown,
): Promise<EnsureFeedbackPrResult> {
  try {
    if (await feedbackPrExists(params)) return { ok: true, created: false }
  } catch {
    // Fall through to the original, more informative error.
  }
  throw createErr
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

// The baseline commit to freeze `feedback` at: the OLDEST commit touching the
// .classroom50.yaml marker (the accept commit), or null when the marker can't
// be resolved — the same rule the runner's baseline_sha() applies. Read-only
// and 404/lag-tolerant (any read failure collapses to null) so callers decide
// what to do with an unresolvable baseline. Accept adds a just-committed-SHA
// fallback on top; the teacher repair has no such fallback and defers instead.
export async function resolveFeedbackBaselineSha(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<string | null> {
  return getOldestCommitShaForPath(
    client,
    org,
    repo,
    ".classroom50.yaml",
  ).catch(() => null)
}

// A teacher-initiated repair returns the ensure result, plus an "unsupported"
// verdict for a repo that structurally can't have a Feedback PR (no baseline
// marker — e.g. an empty_repo assignment), which the UI explains rather than
// surfacing as a transient failure to retry.
export type RepairFeedbackPrResult =
  EnsureFeedbackPrResult | { ok: false; reason: string; unsupported: true }

// Repair a missing Feedback PR from the teacher's side (issue #347): a teacher
// (org admin) runs the SAME idempotent ensureFeedbackPullRequest as accept,
// with their own token, when the student's accept-time attempt failed
// (GitHub outage / transient error) or the repo predates the feature. Resolves
// its own {branch, baseline SHA, mode}: the settled default branch from the
// repo object, the baseline from the .classroom50.yaml marker.
//
// Reuses ensureFeedbackPullRequest so a teacher-repaired PR is byte-identical
// to an accept-time or runner-opened one and the runner still adopts it by
// base+head. Deliberately does NOT widen the base-mismatch guard: a `feedback`
// branch frozen at the wrong SHA still defers (an org admin must delete it),
// never force-updates.
export async function repairFeedbackPullRequest(params: {
  client: GitHubClient
  org: string
  repo: string
  mode: AssignmentMode
}): Promise<RepairFeedbackPrResult> {
  const { client, org, repo, mode } = params

  const repoInfo = await getRepo(client, org, repo)
  if (!repoInfo) {
    return { ok: false, reason: "repo-not-found", unsupported: true }
  }
  const branch = repoInfo.default_branch || "main"

  const acceptCommitSha = await resolveFeedbackBaselineSha(client, org, repo)
  if (!acceptCommitSha) {
    // No .classroom50.yaml marker means no frozen baseline to open the PR
    // against (an empty_repo assignment, or a repo that isn't a Classroom 50
    // assignment repo). The runner refuses the same case.
    return { ok: false, reason: "no-baseline", unsupported: true }
  }

  return ensureFeedbackPullRequest({
    client,
    owner: org,
    repo,
    branch,
    acceptCommitSha,
    mode,
  })
}

// The outcome of one repo in a bulk open, classified for the summary. The
// three failure shapes are deliberately distinct because their remedies are:
//   unsupported  no Feedback PR is possible for this repo (no baseline marker /
//                repo missing) — nothing to retry.
//   blocked      the `feedback` branch is frozen at the wrong SHA — only an org
//                admin deleting the branch fixes it; re-running never will.
//   failed       a transient error (outage / rate limit / lag) — re-running the
//                action retries just the repos still missing a PR.
export type OpenAllOutcome =
  "created" | "existed" | "unsupported" | "blocked" | "failed"

export type OpenAllProgress = {
  done: number
  total: number
}

// Per-repo result kept for the summary's detail lists.
export type OpenAllRepoResult = {
  repo: string
  outcome: OpenAllOutcome
  // Present for the non-success outcomes: the reason to show the teacher.
  reason?: string
}

export type OpenAllFeedbackPrsSummary = {
  total: number
  created: number
  existed: number
  unsupported: OpenAllRepoResult[]
  blocked: OpenAllRepoResult[]
  failed: OpenAllRepoResult[]
  results: OpenAllRepoResult[]
}

// Open a Feedback PR on EVERY assignment repo in one teacher action (issue
// #347): a bounded-concurrency fan-out of repairFeedbackPullRequest over
// `repos`. Idempotent by construction — a repo that already has a PR (any
// state) short-circuits as "existed", so re-running is safe and only fills the
// gaps. A single repo's failure is caught and recorded, never aborting the
// batch (repairFeedbackPullRequest doesn't throw; the try/catch guards an
// unexpected throw so mapWithConcurrency's all-or-nothing reject can't sink the
// whole run). `onProgress` fires after each repo settles so the UI can show a
// live count.
export async function openAllFeedbackPullRequests(params: {
  client: GitHubClient
  org: string
  repos: string[]
  mode: AssignmentMode
  onProgress?: (progress: OpenAllProgress) => void
  signal?: AbortSignal
}): Promise<OpenAllFeedbackPrsSummary> {
  const { client, org, repos, mode, onProgress, signal } = params
  const total = repos.length
  let done = 0

  const results = await mapWithConcurrency(
    repos,
    REPO_READ_CONCURRENCY,
    async (repo): Promise<OpenAllRepoResult> => {
      if (signal?.aborted) return { repo, outcome: "failed", reason: "aborted" }
      let result: OpenAllRepoResult
      try {
        const r = await repairFeedbackPullRequest({ client, org, repo, mode })
        if (r.ok) {
          result = { repo, outcome: r.created ? "created" : "existed" }
        } else if ("unsupported" in r) {
          result = { repo, outcome: "unsupported", reason: r.reason }
        } else if (r.code === "base-mismatch") {
          // Never-retryable: an org admin must delete the mis-frozen branch.
          // Keep it out of `failed` so the "re-run to retry" copy stays honest.
          result = { repo, outcome: "blocked", reason: r.reason }
        } else {
          result = { repo, outcome: "failed", reason: r.reason }
        }
      } catch (err) {
        result = {
          repo,
          outcome: "failed",
          reason: err instanceof Error ? err.message : String(err),
        }
      }
      done++
      onProgress?.({ done, total })
      return result
    },
  )

  return {
    total,
    created: results.filter((r) => r.outcome === "created").length,
    existed: results.filter((r) => r.outcome === "existed").length,
    unsupported: results.filter((r) => r.outcome === "unsupported"),
    blocked: results.filter((r) => r.outcome === "blocked"),
    failed: results.filter((r) => r.outcome === "failed"),
    results,
  }
}
