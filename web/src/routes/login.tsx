import { createFileRoute, redirect } from "@tanstack/react-router"
import { GitHubAuthCard } from "@/auth/GitHubAuthCard"
import { isSafeReturnTo } from "@/auth/returnTo"

// `redirect`: where to send the user after a successful sign-in — set when the
// _authed guard (or App's session-expiry redirect) bounces an unauthenticated
// user here. Only a same-origin relative path (leading "/", not "//") is kept,
// so it can't become an open redirect (#71). The unauthenticated → sign-in →
// return path is handled in useGithubAuth (the param can't survive the GitHub
// round-trip, so it's stashed in the OAuth session); this guard covers the
// already-authenticated case — landing on /login?redirect=X while signed in.

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
