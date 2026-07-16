import { useEffect } from "react"
import { RouterProvider, useRouterState } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import router from "./router"
import { Spinner } from "@/components/Spinner"
import { Button } from "@/components/ui"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useGitHubHealth } from "@/lib/githubHealth"
import { GitHubStatusNote } from "@/components/GitHubStatusBanner"
import { BASE_PATH, isAuthedPath } from "@/auth/authedPath"
import { logger } from "@/lib/logger"

const log = logger.scope("app")

export function App() {
  const {
    status,
    token,
    user,
    isOnline,
    isValidatingStuck,
    retryUserValidation,
    signOut,
  } = useGithubAuth()
  const { t } = useTranslation()
  const {
    suspected: githubSuspected,
    statusDescription: githubStatusDescription,
  } = useGitHubHealth()

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
    // A settled, persistent validation failure would otherwise spin forever
    // (see isValidationStuck). Offer an escape: retry /user, or sign out to a
    // clean re-login.
    if (isValidatingStuck) {
      return (
        <div className="min-h-screen grid place-items-center p-6">
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <Spinner size="lg" label={t("common.loadingApp")} />
            <p className="text-sm text-base-content/70">
              {t("auth.validationStuck")}
            </p>
            {githubSuspected ? (
              <p className="text-sm text-base-content/70">
                <GitHubStatusNote statusDescription={githubStatusDescription} />
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button variant="primary" onClick={retryUserValidation}>
                {t("submissions.errors.retry")}
              </Button>
              <Button variant="ghost" onClick={signOut}>
                {t("auth.validationStuckSignIn")}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    // Offline with a stored token that can't be validated yet: explain the hold
    // rather than showing a bare, indefinite "loading" spinner (the session is
    // preserved and resumes when connectivity returns).
    const label =
      !isOnline && token ? t("auth.offlineHold") : t("common.loadingApp")
    return (
      <div className="min-h-screen grid place-items-center">
        <Spinner size="lg" label={label} />
      </div>
    )
  }

  return <RouterProvider router={router} context={{ auth: { user, status } }} />
}

export default App
