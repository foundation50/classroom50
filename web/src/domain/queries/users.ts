import type { GitHubClient } from "@/github-core/client"
import type { GitHubUser } from "@/github-core/types"

export async function getAuthenticatedUser(client: GitHubClient) {
  return client.request<GitHubUser>("/user")
}
