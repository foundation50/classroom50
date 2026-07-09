import { useEffect } from "react"
import { RouterProvider, useRouterState } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import router from "./router"
import { Spinner } from "@/components/Spinner"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { BASE_PATH, isAuthedPath } from "@/auth/authedPath"
import { logger } from "@/lib/logger"

const log = logger.scope("app")

export function App() {
  const { status, token, user } = useGithubAuth()
  const { t } = useTranslation()

  useEffect(() => {
    if (status === "loading") return
    log.debug("auth status settled, invalidating router", { status })
    void router.invalidate()
  }, [status, token])

  // Subscribe to router location (not window.location) so App re-renders when
  // the redirect below lands on /login and clears the spinner (#signout-stuck).
  const pathname = useRouterState({
    router,
    select: (s) => s.location.pathname,
  })
  // Redirect eagerly rather than waiting for invalidate(): unmounts the authed
  // subtree synchronously, closing the null-client crash window. No ?redirect=
  // — sign-out is deliberate.
  const sessionEndedOnAuthedRoute =
    status === "unauthenticated" && isAuthedPath(pathname)

  useEffect(() => {
    if (!sessionEndedOnAuthedRoute) return
    log.info("session ended on authed route, redirecting to /login")
    // Hard-redirect fallback: a rejected navigate() would leave the spinner up
    // forever (the effect won't re-run — its only dep is unchanged).
    router.navigate({ to: "/login" }).catch(() => {
      log.warn("navigate to /login failed, hard-redirecting", { record: true })
      window.location.assign(`${BASE_PATH}/login`)
    })
  }, [sessionEndedOnAuthedRoute])

  if (status === "loading" || sessionEndedOnAuthedRoute) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Spinner size="lg" label={t("common.loadingApp")} />
      </div>
    )
  }

  return <RouterProvider router={router} context={{ auth: { user, status } }} />
}

export default App
