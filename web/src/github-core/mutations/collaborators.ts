import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

// After a collaborator PUT, GitHub reports the effective role here. A silently
// ignored write (e.g. a downgrade GitHub won't apply to a repo creator, or a
// higher team/base grant) returns 204 on the PUT but leaves this unchanged, so
// callers that must confirm the grant took read it back.
async function readEffectivePermission(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
}): Promise<{ permission?: string; role_name?: string }> {
  const { client, org, repo, username } = params
  return client.request(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
  )
}

export async function addRepoCollaborator(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
  permission?: "pull" | "triage" | "push" | "maintain" | "admin"
  // When set, read the effective permission back after the PUT and return it so
  // the caller can confirm the write actually landed (a bare 204 doesn't prove
  // a downgrade took). Omitted for callers that only need the write issued.
  verify?: boolean
}): Promise<{ effective?: { permission?: string; role_name?: string } }> {
  const {
    client,
    org,
    repo,
    username,
    permission = "push",
    verify = false,
  } = params

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

  await client.requestRaw(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      body: {
        permission,
      },
    },
  )

  if (!verify) return {}

  const effective = await readEffectivePermission({
    client,
    org,
    repo,
    username,
  })
  return { effective }
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
