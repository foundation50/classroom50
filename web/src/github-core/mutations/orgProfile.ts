import type { GitHubClient } from "../client"
import type { GitHubOrgDetails } from "../types"

// The org profile fields Classroom 50 lets an owner edit in-app. Mirrors the
// writable subset of PATCH /orgs/{org}; `blog` is GitHub's field name for the
// public website. Avatar is intentionally absent — GitHub's REST API has no
// endpoint to set an org's avatar (web-only), so it stays read-only in the UI.
export type OrgProfileUpdate = {
  name?: string
  description?: string
  blog?: string
  location?: string
  email?: string
  company?: string
}

// PATCH /orgs/{org} with the given profile fields. Requires the token to have
// org-owner (admin) rights; a member's token gets a 403. Returns the updated
// org object so the caller can seed the cache.
export async function updateOrgProfile(
  client: GitHubClient,
  org: string,
  update: OrgProfileUpdate,
): Promise<GitHubOrgDetails> {
  return client.request<GitHubOrgDetails>(`/orgs/${org}`, {
    method: "PATCH",
    body: update,
  })
}
