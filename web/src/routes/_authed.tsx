import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { ScopeWarningBanner } from "@/auth/ScopeWarningBanner"
import { SkeletonDriftBanner } from "@/components/SkeletonDriftBanner"

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    const { auth } = context
    if (auth.status === "unauthenticated") {
      throw redirect({
        to: "/login",
        search: {
          // Same-origin relative path only (see isSafeReturnTo), so the
          // destination survives the round-trip without open-redirect risk.
          // Consumed post-auth in useGithubAuth and login.tsx's guard (#71).
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
      <SkeletonDriftBanner />
      <Outlet />
    </>
  )
}
