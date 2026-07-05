import { createFileRoute, redirect } from "@tanstack/react-router"
import { GitHubAuthCard } from "@/auth/GitHubAuthCard"
import { isSafeReturnTo } from "@/auth/returnTo"

// `redirect`: same-origin path to return to after sign-in, set when the _authed
// guard (or App's session-expiry redirect) bounces an unauthenticated user here
// (#71). useGithubAuth handles the sign-in round-trip; this guard covers the
// already-authenticated case. The value is pathname + search, so it may carry a
// query (e.g. the ?k= accept key); `redirect({ to })` would fold that into the
// pathname, so split into { to, search } first. /login is rejected to avoid a
// self-redirect hop.
function toRedirectTarget(value: string): {
  to: string
  search: Record<string, string>
} {
  const queryIndex = value.indexOf("?")
  const to = queryIndex === -1 ? value : value.slice(0, queryIndex)
  const search =
    queryIndex === -1
      ? {}
      : Object.fromEntries(new URLSearchParams(value.slice(queryIndex + 1)))
  return { to, search }
}

function safeRedirect(value: unknown): string | undefined {
  if (!isSafeReturnTo(value)) return undefined
  const { to } = toRedirectTarget(value)
  return to === "/login" ? undefined : value
}

export const Route = createFileRoute("/login")({
  component: GitHubAuthCard,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: ({ context, search }) => {
    const { auth } = context
    if (auth.status === "authenticated") {
      throw redirect(
        search.redirect ? toRedirectTarget(search.redirect) : { to: "/" },
      )
    }
  },
})
