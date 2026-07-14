import type { GitHubUser } from "@/github-core/types"

// Auth status as surfaced by useGithubAuth().status — the router guards branch
// on these exact values.
export type AuthStatus = "loading" | "unauthenticated" | "authenticated"

// Router-wide context, declared on the root route so `beforeLoad`'s
// `context.auth` is typed in every route. `user` is null until authenticated.
export type RouterContext = {
  auth: {
    user: GitHubUser | null
    status: AuthStatus
  }
}
