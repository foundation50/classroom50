import {
  AlertIcon,
  InfoIcon,
  MarkGithubIcon,
  MortarBoardIcon,
} from "@/components/ui/icons"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"

import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useGithubAuth } from "./useGithubAuth"
import { GitHubAuthedPanel } from "./GitHubAuthedPanel"
import { GitHubDevicePrompt } from "./GitHubDevicePrompt"
import { GitHubPatPrompt } from "./GitHubPatPrompt"
import { LoginLanguageMenu } from "./LoginLanguageMenu"
import { AppVersionBadge } from "@/components/AppVersionBadge"
import { WIKI_URL } from "@/version"
import { Alert, Button, Card, Spinner } from "@/components/ui"

function LoadingScreen({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center gap-4 py-10 text-center text-base-content/70"
      role="status"
    >
      <Spinner size="lg" />
      <p className="text-sm">{label}</p>
    </div>
  )
}

// Which alert the sign-in form shows, in precedence order. Offline wins: the
// user never signed out, so a stale error or expiry notice would misexplain the
// state. Then a live sign-in error, then the involuntary-expiry notice. Pure so
// the precedence is unit-testable without rendering the whole card.
export type LoginAlertKind = "offline" | "error" | "expired" | null

export function resolveLoginAlert(input: {
  isOnline: boolean
  error: string | null
  sessionExpired: boolean
}): LoginAlertKind {
  if (!input.isOnline) return "offline"
  if (input.error) return "error"
  if (input.sessionExpired) return "expired"
  return null
}

export function GitHubAuthCard() {
  const { t } = useTranslation()
  useDocumentTitle(t("auth.signInTitle"))
  const auth = useGithubAuth()

  return (
    <main className="flex min-h-screen items-center justify-center bg-base-100 px-4 py-8">
      <Card as="section" className="relative w-full max-w-lg">
        <div className="absolute end-3 top-3 z-10">
          <LoginLanguageMenu />
        </div>
        <header className="flex items-center gap-4 border-b border-base-200 px-7 py-6">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MortarBoardIcon aria-hidden="true" className="size-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t("nav.appName")}
            </h1>
            <p className="mt-1 text-sm text-base-content/70">
              {t("auth.signInSubtitle")}
            </p>
          </div>
        </header>

        <Card.Body>
          {auth.screen === "authed" ? (
            auth.isLoadingUser && !auth.user ? (
              // "authed" screen before GET /user resolves: on cold reload (mount
              // effect) or right after sign-in. Show a spinner and let the guard
              // redirect once the profile lands, rather than flashing a
              // half-built panel or a success splash.
              <LoadingScreen label={t("auth.verifyingSession")} />
            ) : (
              <GitHubAuthedPanel user={auth.user} onSignOut={auth.signOut} />
            )
          ) : auth.screen === "exchanging" ? (
            <LoadingScreen label={t("auth.exchangingCode")} />
          ) : auth.screen === "device-prompt" && auth.device ? (
            <GitHubDevicePrompt
              device={auth.device}
              status={auth.deviceStatus}
              onCancel={auth.cancelDeviceFlow}
              onCodeCopied={auth.markDeviceCodeCopied}
              onVerificationOpened={auth.markVerificationOpened}
            />
          ) : auth.screen === "pat-prompt" ? (
            <GitHubPatPrompt
              tokenType={auth.patTokenType}
              onSubmit={auth.submitPat}
              onCancel={auth.cancelPatFlow}
              isValidating={auth.isValidatingPat}
              error={auth.patError}
            />
          ) : (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault()
                void auth.startWebFlow()
              }}
            >
              {(() => {
                const alert = resolveLoginAlert({
                  isOnline: auth.isOnline,
                  error: auth.error,
                  sessionExpired: auth.sessionExpired,
                })
                if (!alert) return null
                const tone = alert === "error" ? "error" : "warning"
                const message =
                  alert === "offline"
                    ? t("auth.offlineHold")
                    : alert === "error"
                      ? auth.error
                      : t("auth.sessionExpired")
                // "expired" is an informational "please sign in again" prompt,
                // not a fault; the warning triangle overstates it, so only the
                // offline/error tones carry the alert icon.
                const Icon = alert === "expired" ? InfoIcon : AlertIcon
                return (
                  <Alert tone={tone} className="items-start text-sm">
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span>{message}</span>
                  </Alert>
                )
              })()}

              <div className="space-y-3">
                <Button
                  variant="primary"
                  className="w-full"
                  type="submit"
                  loading={auth.isStartingWebFlow}
                  disabled={auth.isStartingWebFlow}
                >
                  {auth.isStartingWebFlow ? null : (
                    <MarkGithubIcon aria-hidden="true" className="size-4" />
                  )}
                  {t("auth.signInWithGitHub")}
                </Button>

                <details className="collapse collapse-arrow border border-base-300 bg-base-100">
                  <summary className="collapse-title min-h-0 px-4 py-3 text-sm font-medium">
                    {t("auth.otherSignInMethods")}
                  </summary>

                  <div className="collapse-content space-y-3">
                    <p className="text-xs text-base-content/60">
                      {t("auth.otherSignInMethodsHint")}
                    </p>
                    <Button
                      variant="outline"
                      className="w-full"
                      type="button"
                      loading={auth.isRequestingDeviceCode}
                      disabled={auth.isRequestingDeviceCode}
                      onClick={() => void auth.startDeviceFlow()}
                    >
                      {t("auth.useDeviceCode")}
                    </Button>

                    <Button
                      variant="outline"
                      className="w-full"
                      type="button"
                      onClick={() => auth.startPatFlow("classic")}
                    >
                      {t("auth.usePersonalAccessTokenClassic")}
                    </Button>

                    <Button
                      variant="outline"
                      className="w-full"
                      type="button"
                      onClick={() => auth.startPatFlow("fine-grained")}
                    >
                      {t("auth.usePersonalAccessTokenFineGrained")}
                    </Button>
                  </div>
                </details>
              </div>
            </form>
          )}
        </Card.Body>

        <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-base-200 px-7 py-4 text-xs text-base-content/70">
          <span className="min-w-0">{t("auth.footerTagline")}</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <AppVersionBadge className="tabular-nums text-base-content/50" />
            <Link className="link link-info link-hover" to="/accessibility">
              {t("auth.accessibility")}
            </Link>
            <a
              className="link link-info link-hover"
              href={WIKI_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("auth.visitDocs")}
            </a>
          </div>
        </footer>
      </Card>
    </main>
  )
}
