import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubUser } from "../types"
import { githubKeys } from "./keys"

export function viewerQuery(client: GitHubClient) {
  return queryOptions({
    queryKey: githubKeys.viewer(),
    queryFn: ({ signal }) =>
      client.request<GitHubUser>("/user", { method: "GET", signal }),
    staleTime: 10 * 60 * 1000,
  })
}

export function getUser(client: GitHubClient, username: string) {
  return client.request<GitHubUser>(`/users/${encodeURIComponent(username)}`)
}

// Resolve a user by their immutable numeric account id (GET /user/{id}). The
// stored CSV username goes stale if the student renames their GitHub account,
// but the id never changes — so this returns their CURRENT login. Used when
// re-inviting a roster student whose username may have drifted.
export function getUserById(client: GitHubClient, id: number | string) {
  return client.request<GitHubUser>(`/user/${encodeURIComponent(String(id))}`)
}

export function getUserQuery(client: GitHubClient, username: string) {
  return queryOptions({
    queryKey: githubKeys.user(username),
    queryFn: ({ signal }) =>
      client.request<GitHubUser>(`/users/${encodeURIComponent(username)}`, {
        method: "GET",
        signal,
      }),
    staleTime: 10 * 60 * 1000,
  })
}
