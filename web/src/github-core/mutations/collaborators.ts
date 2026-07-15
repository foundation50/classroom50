import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

export async function addRepoCollaborator(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
  permission?: "pull" | "triage" | "push" | "maintain" | "admin"
}) {
  const { client, org, repo, username, permission = "push" } = params

  // Only a definitive 404 (not an org member) blocks the add; transient errors
  // (rate limit, 5xx, private-membership 403) fall through to the PUT rather
  // than falsely rejecting a valid member.
  try {
    await client.requestRaw(
      `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) throw err
  }

  const res = await client.requestRaw(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      body: {
        permission,
      },
    },
  )

  return res
}

export async function removeRepoCollaborator(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
}) {
  const { client, org, repo, username } = params

  return client.request(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "DELETE",
    },
  )
}
