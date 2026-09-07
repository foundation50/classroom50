import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"
import type { RepoPermission } from "@/types/classroom"

// The effective-permission read after a collaborator PUT. A silently ignored
// write (a downgrade GitHub won't apply to a repo creator, or a higher team/base
// grant) returns 204 on the PUT but leaves this unchanged, so callers that must
// confirm the grant took read it back. Returns undefined when the sub-resource
// can't be read yet: right after a fresh PUT this endpoint lags by a long,
// unbounded window and 404s (or the read is otherwise transiently unavailable)
// even though the write applied, so a non-readable result is UNVERIFIED, not a
// failure — the accept path dropped its read-back entirely for this same reason.
async function readEffectivePermission(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
}): Promise<{ permission?: string; role_name?: string } | undefined> {
  const { client, org, repo, username } = params
  try {
    return await client.request(
      `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
    )
  } catch (err) {
    // The PUT already succeeded (checked by the caller); a failed read-back only
    // means we can't confirm the effective role, so report it as unverified
    // rather than turning a landed write into a spurious failure. A 404 is the
    // common not-yet-readable case; a transient 5xx/rate-limit is treated the
    // same — the write stands, verification is simply inconclusive.
    if (err instanceof GitHubAPIError) return undefined
    throw err
  }
}

export async function addRepoCollaborator(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
  permission?: RepoPermission
  // When set, read the effective permission back after the PUT and return it so
  // the caller can confirm the write actually landed (a bare 204 doesn't prove
  // a downgrade took). `effective` is undefined when the read-back couldn't be
  // read (the sub-resource lags a fresh PUT) — the write still stands, so the
  // caller treats an undefined read-back as issued-but-unconfirmed, never as a
  // failure. Omitted entirely for callers that only need the write issued.
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

// The GitHub repo-feature toggles PATCH /repos accepts. Only the keys present
// are changed. Shared with the accept path's RepoFeaturePatch shape. The About
// (`description`) rides the same PATCH — accept copies the template's About
// onto a student repo through this body (issue #569).
export type RepoFeaturePatch = {
  has_issues?: boolean
  has_wiki?: boolean
  has_projects?: boolean
  has_pull_requests?: boolean
  description?: string
}

// Set a repo's feature toggles (Issues/Wiki/Projects/Pull requests) via
// PATCH /repos/{org}/{repo}. Sends only the provided keys. Throws on failure so
// a bulk caller can record the per-repo outcome (unlike the accept path's
// fail-open patchRepoSurface, whose whole job is to never block accept).
export async function setRepoFeatures(params: {
  client: GitHubClient
  org: string
  repo: string
  features: RepoFeaturePatch
}): Promise<void> {
  const { client, org, repo, features } = params
  await client.request(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      body: features,
    },
  )
}

// Set a repo's visibility via PATCH /repos/{org}/{repo} ({ private }). Used by
// the gradebook's per-repo and bulk visibility actions (issue #766) — student
// repos are private or public only, never GitHub's enterprise "internal".
// Throws on failure so a bulk caller can record the per-repo outcome.
export async function setRepoVisibility(params: {
  client: GitHubClient
  org: string
  repo: string
  visibility: "private" | "public"
}): Promise<void> {
  const { client, org, repo, visibility } = params
  await client.request(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      body: { private: visibility === "private" },
    },
  )
}

// Replace a repo's Topics via PUT /repos/{org}/{repo}/topics (the modern
// endpoint — no preview media type needed; the body is { names }). Used by
// accept to copy the template's Topics onto a student repo (issue #569).
// Throws on failure so the accept path's own fail-open wrapper decides whether
// to swallow it (topics are best-effort, never a reason to fail accept).
export async function replaceRepoTopics(params: {
  client: GitHubClient
  org: string
  repo: string
  topics: string[]
}): Promise<void> {
  const { client, org, repo, topics } = params
  await client.request(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/topics`,
    {
      method: "PUT",
      body: { names: topics },
    },
  )
}
