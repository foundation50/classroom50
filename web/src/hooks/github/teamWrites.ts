import type { GitHubClient } from "./client"
import type { GitHubTeam } from "./types"

export type CreateTeamInput = {
  org: string
  name: string
  description?: string
  privacy?: "secret" | "closed"
  maintainers?: string[]
  repo_names?: string[]
}
export function createTeam(client: GitHubClient, input: CreateTeamInput) {
  const { org, ...body } = input

  return client.request<GitHubTeam>(`/orgs/${org}/teams`, {
    method: "POST",
    body: {
      privacy: "closed",
      notification_setting: "notifications_disabled",
      ...body,
    },
  })
}
