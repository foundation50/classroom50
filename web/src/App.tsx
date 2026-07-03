import { useEffect } from "react"
import { RouterProvider } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import router from "./router"
import { Spinner } from "@/components/Spinner"
import { useGithubAuth } from "@/auth/useGithubAuth"

// Auth-gated route prefixes. When the session ends mid-flight, the router keeps
// the matched _authed route mounted until a post-commit invalidate() swaps it
// out — one render frame in which the authed subtree re-renders against a now
// null GitHub client and useGitHubClient() throws into the root error boundary.
// We detect that transient window below and render a redirect state instead.
function isAuthedPath(pathname: string): boolean {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "")
  const path =
    base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname
  return path !== "/login" && path !== "/"
}

export function App() {
  const { status, token, user } = useGithubAuth()
  const { t } = useTranslation()

  useEffect(() => {
    if (status === "loading") return
    void router.invalidate()
  }, [status, token])

  // When the session ends while on an authed route, redirect to /login eagerly
  // (carrying the destination so re-auth can return there — see issue #71)
  // rather than waiting for the post-commit invalidate(). This unmounts the
  // authed subtree synchronously, closing the null-client crash window.
  const pathname = window.location.pathname
  const sessionEndedOnAuthedRoute =
    status === "unauthenticated" && isAuthedPath(pathname)

  useEffect(() => {
    if (!sessionEndedOnAuthedRoute) return
    void router.navigate({
      to: "/login",
      search: { redirect: window.location.pathname + window.location.search },
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
