import { createFileRoute, redirect } from "@tanstack/react-router"
import { GitHubAuthCard } from "@/auth/GitHubAuthCard"

// `redirect`: where to send the user after a successful sign-in — set when the
// _authed guard (or App's session-expiry redirect) bounces an unauthenticated
// user here. Only a same-origin relative path (leading "/", not "//") is kept,
// so it can't become an open redirect. Consuming it post-auth is tracked in
// issue #71; validating it here reserves the param and keeps it safe now.
const isSafeRedirect = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")

export const Route = createFileRoute("/login")({
  component: GitHubAuthCard,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: isSafeRedirect(search.redirect) ? search.redirect : undefined,
  }),
  beforeLoad: ({ context }) => {
    const { auth } = context
    if (auth.status === "authenticated") {
      throw redirect({
        to: "/",
      })
    }
  },
})
