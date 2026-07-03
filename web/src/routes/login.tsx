import { createFileRoute, redirect } from "@tanstack/react-router"
import { GitHubAuthCard } from "@/auth/GitHubAuthCard"
import { isSafeReturnTo } from "@/auth/returnTo"

// `redirect`: same-origin path to return to after sign-in, set when the _authed
// guard (or App's session-expiry redirect) bounces an unauthenticated user
// here (#71). The sign-in round-trip is handled in useGithubAuth (stashed in
// the OAuth session); this guard covers the already-authenticated case.

export const Route = createFileRoute("/login")({
  component: GitHubAuthCard,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: isSafeReturnTo(search.redirect) ? search.redirect : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    const { auth } = context
    if (auth.status === "authenticated") {
      throw redirect({
        to: search.redirect ?? "/",
      })
    }
  },
})
