import { createFileRoute, redirect, useParams } from "@tanstack/react-router"
import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ScopeWarningBanner } from "@/auth/ScopeWarningBanner"
import { SkeletonDriftBanner } from "@/components/SkeletonDriftBanner"
import { BudgetCreatedBanner } from "@/components/BudgetCreatedBanner"
import { OfflineBanner } from "@/components/OfflineBanner"
import { GitHubStatusBanner } from "@/components/GitHubStatusBanner"
import { UpdateAvailableBanner } from "@/components/UpdateAvailableBanner"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { GitHubOrgRoleProvider } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { ClassroomRoleProvider } from "@/context/classroomRole/ClassroomRoleProvider"
import { Spinner } from "@/components/Spinner"
import { AppShell } from "@/components/drawer"
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
    <AuthedShell
      topSlot={
        <>
          <OfflineBanner />
          <GitHubStatusBanner />
          <ScopeWarningBanner />
          <SkeletonDriftBanner />
          <BudgetCreatedBanner />
          <UpdateAvailableBanner />
        </>
      }
    />
  )
}

// The role providers now wrap the PERSISTENT shell (sidebar + Outlet) rather
// than the per-level layout routes: the hoisted sidebar reads the classroom/org
// role, and it lives above $org/$classroom, so the providers must too. Both are
// param-tolerant (reads disable to `unresolved` off-route), and keys reset the
// resolution when the org/classroom changes so a stale role never leaks across
// boundaries. Child pages + layout gates read this single instance.
function AuthedShell({ topSlot }: { topSlot?: ReactNode }) {
  const { org, classroom } = useParams({ strict: false })
  return (
    <GitHubOrgRoleProvider key={org ?? "no-org"} org={org}>
      <ClassroomRoleProvider
        key={`${org ?? "no-org"}/${classroom ?? "no-classroom"}`}
        org={org}
        classroom={classroom}
      >
        <AppShell topSlot={topSlot} />
      </ClassroomRoleProvider>
    </GitHubOrgRoleProvider>
  )
}
