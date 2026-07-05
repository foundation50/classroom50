import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { ScopeWarningBanner } from "@/auth/ScopeWarningBanner"
import { SkeletonDriftBanner } from "@/components/SkeletonDriftBanner"

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    const { auth } = context
    if (auth.status === "unauthenticated") {
      // Carry a deep link so a shared sub-route survives the login round-trip
      // (#71); skip it for "/" (the post-login default) to avoid a noisy
      // ?redirect=%2F. Root-by-pathname only — a stray query on "/" isn't worth
      // round-tripping.
      const returnTo = location.pathname + location.searchStr
      const isRoot = location.pathname === "/"
      throw redirect({
        to: "/login",
        search: isRoot ? undefined : { redirect: returnTo },
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
