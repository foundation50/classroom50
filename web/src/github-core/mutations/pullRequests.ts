import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

// Pull-request + branch-ref + label writes for the accept-time Feedback PR
// (issue #228). Kept transport-thin like the sibling sub-modules: the
// orchestration (idempotency, empty-commit fallback, best-effort semantics)
// lives in domain/assignments/feedbackPr.ts.

export type PullRequestSummary = {
  number: number
  state: string
  html_url: string
}

// List PRs matching base<-head in ANY state (open/closed/merged), newest
// first. `head` must be owner-qualified ("org:branch") per the GitHub API.
export function listPullRequestsByBaseHead(params: {
  client: GitHubClient
  owner: string
  repo: string
  base: string
  head: string
}) {
  const { client, owner, repo, base, head } = params
  return client.request<PullRequestSummary[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${head}`)}&state=all&per_page=1`,
  )
}

export function createPullRequest(params: {
  client: GitHubClient
  owner: string
  repo: string
  base: string
  head: string
  title: string
  body: string
}) {
  const { client, owner, repo, base, head, title, body } = params
  return client.request<PullRequestSummary>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    {
      method: "POST",
      body: { base, head, title, body },
    },
  )
}

// Create refs/heads/<branch> at `sha`. Resolves false (instead of throwing)
// when the ref already exists — the idempotent re-run case.
export async function createBranchRef(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
  sha: string
}): Promise<boolean> {
  const { client, owner, repo, branch, sha } = params
  try {
    await client.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha },
      },
    )
    return true
  } catch (err) {
    if (is422AlreadyExists(err)) return false
    throw err
  }
}

// Create the label with a pinned color (adding a nonexistent label to an
// issue auto-creates it with a random color, so create-first matters).
// Tolerates already-exists.
export async function ensureRepoLabel(params: {
  client: GitHubClient
  owner: string
  repo: string
  name: string
  color: string
  description?: string
}) {
  const { client, owner, repo, name, color, description } = params
  try {
    await client.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`,
      {
        method: "POST",
        body: { name, color, description },
      },
    )
  } catch (err) {
    if (!is422AlreadyExists(err)) throw err
  }
}

export function addIssueLabels(params: {
  client: GitHubClient
  owner: string
  repo: string
  issueNumber: number
  labels: string[]
}) {
  const { client, owner, repo, issueNumber, labels } = params
  return client.request(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
    {
      method: "POST",
      body: { labels },
    },
  )
}

// GitHub reports "already exists" for both duplicate refs and duplicate
// labels as a 422 whose message/errors mention it; there is no structured
// code beyond the generic "custom"/"already_exists" variants, so match text
// (mirrors the CLI's is422AlreadyExists).
export function is422AlreadyExists(err: unknown): boolean {
  if (!(err instanceof GitHubAPIError) || err.status !== 422) return false
  return apiErrorMentions(err, "already exists") || apiErrorMentions(err, "already_exists")
}

// The "no commits between base and head" 422 GitHub returns for a zero-diff
// PR — the accept-time signal to land the empty commit and retry.
export function is422NoCommitsBetween(err: unknown): boolean {
  if (!(err instanceof GitHubAPIError) || err.status !== 422) return false
  return apiErrorMentions(err, "no commits between")
}

function apiErrorMentions(err: GitHubAPIError, needle: string): boolean {
  if (err.message.toLowerCase().includes(needle)) return true
  const body = err.body as
    | { message?: string; errors?: Array<{ message?: string; code?: string }> }
    | undefined
  if (body?.message?.toLowerCase().includes(needle)) return true
  return (body?.errors ?? []).some(
    (item) =>
      item?.message?.toLowerCase().includes(needle) ||
      item?.code?.toLowerCase().includes(needle),
  )
}
