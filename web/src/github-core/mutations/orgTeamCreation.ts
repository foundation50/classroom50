import type { GitHubClient } from "../client"
import type { GitHubOrgDetails } from "../types"

// PATCH /orgs/{org} flipping the "Allow members to create teams" member
// privilege. Owner-only, like updateOrgProfile. Enabled is what student-formed
// group assignments need (team_formation: student — the founding student
// creates the GitHub team at accept). Returns the updated org so the caller
// can seed the shared orgDetails cache.
export async function updateOrgTeamCreation(
  client: GitHubClient,
  org: string,
  allow: boolean,
): Promise<GitHubOrgDetails> {
  return client.request<GitHubOrgDetails>(`/orgs/${org}`, {
    method: "PATCH",
    body: { members_can_create_teams: allow },
  })
}
