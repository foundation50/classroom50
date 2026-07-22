import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ScopeWarningBanner } from "@/auth/ScopeWarningBanner"
import { SkeletonDriftBanner } from "@/components/SkeletonDriftBanner"
import { BudgetCreatedBanner } from "@/components/BudgetCreatedBanner"
import { OfflineBanner } from "@/components/OfflineBanner"
import { GitHubStatusBanner } from "@/components/GitHubStatusBanner"
import { UpdateAvailableBanner } from "@/components/UpdateAvailableBanner"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { Spinner } from "@/components/Spinner"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_ROUTER } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_ROUTER)

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
      log.info("auth guard: unauthenticated, redirecting to /login", {
        from: location.pathname,
      })
      throw redirect({
        to: "/login",
        search: isRoot ? undefined : { redirect: returnTo },
      })
    }
  },

  component: AuthedLayout,
})

function AuthedLayout() {
  // The GitHub client is null for a render frame when the token is torn down
  // (sign-out, or a 401 expiring the session) before the router's async
  // invalidate fires the redirect to /login. Hold the authed subtree until the
  // client exists so its pages don't mount and call useGitHubClient() on a null
  // client — otherwise every authed hook throws during that gap.
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()

  if (!client) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Spinner size="lg" label={t("common.loadingApp")} />
      </div>
    )
  }

  return (
    <>
      <OfflineBanner />
      <GitHubStatusBanner />
      <ScopeWarningBanner />
      <SkeletonDriftBanner />
      <BudgetCreatedBanner />
      <UpdateAvailableBanner />
      <Outlet />
    </>
  )
}
