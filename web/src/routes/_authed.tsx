import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { ScopeWarningBanner } from "@/auth/ScopeWarningBanner"

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    const { auth } = context
    if (auth.status === "unauthenticated") {
      throw redirect({
        to: "/login",
        search: {
          // Same-origin relative path only (see /login's isSafeRedirect), so
          // the destination survives the round-trip without an open-redirect
          // risk. Consuming it post-auth is tracked in issue #71.
          redirect: location.pathname + location.searchStr,
        },
      })
    }
  },

  component: AuthedLayout,
})

function AuthedLayout() {
  return (
    <>
      <ScopeWarningBanner />
      <Outlet />
    </>
  )
}
