import { useEffect } from "react"
import { RouterProvider, useRouterState } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import router from "./router"
import { Spinner } from "@/components/Spinner"
import { useGithubAuth } from "@/auth/useGithubAuth"

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "")

// Public auth screens; everything else (incl. the app home "/") is authed and
// must bounce to /login when the session ends. When a session ends mid-flight
// the router keeps the authed route mounted for a frame — the subtree re-renders
// against a now-null GitHub client and useGitHubClient() throws — so App renders
// a redirect state instead (see sessionEndedOnAuthedRoute).
function isAuthedPath(pathname: string): boolean {
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length)
      : pathname
  return path !== "/login" && path !== "/auth" && path !== "/auth/"
}

export function App() {
  const { status, token, user } = useGithubAuth()
  const { t } = useTranslation()

  useEffect(() => {
    if (status === "loading") return
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
    // Hard-redirect fallback: a rejected navigate() would leave the spinner up
    // forever (the effect won't re-run — its only dep is unchanged).
    router.navigate({ to: "/login" }).catch(() => {
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
