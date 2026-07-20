import type { GitHubClient } from "./client"
import type { GitHubTeam, TeamNotificationSetting } from "./types"

// Re-exported for callers; the type lives in types.ts to avoid an import cycle.
export type { TeamNotificationSetting }

export type CreateTeamInput = {
  org: string
  name: string
  description?: string
  privacy?: "secret" | "closed"
  notification_setting?: TeamNotificationSetting
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
