import type { GitHubClient } from "../client"
import type { GitHubPullRequest } from "../types"
import { is422AlreadyExists } from "../errors"

// Pull-request + branch-ref + label WRITES for the accept-time Feedback PR
// (issue #228). Kept transport-thin like the sibling sub-modules: the
// orchestration (idempotency, empty-commit fallback, best-effort semantics)
// lives in domain/assignments/feedbackPr.ts, the base+head read in
// queries/repoRefReads.ts, and the 422 discriminators in ../errors.
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
  return client.request<GitHubPullRequest>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    {
      method: "POST",
      body: { base, head, title, body },
    },
  )
}

// Create refs/heads/<branch> at `sha`. Resolves false (instead of throwing)
// when the ref already exists, so the caller can verify where it points before
// adopting it.
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
