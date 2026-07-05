import { AlertTriangle, GraduationCap } from "lucide-react"
import { useTranslation } from "react-i18next"
import GitHub from "@/assets/github.svg?react"

import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useGithubAuth } from "./useGithubAuth"
import { GitHubAuthedPanel } from "./GitHubAuthedPanel"
import { GitHubDevicePrompt } from "./GitHubDevicePrompt"
import { LoginLanguageMenu } from "./LoginLanguageMenu"
import { AppVersionBadge } from "@/components/AppVersionBadge"
import { WIKI_URL } from "@/version"

function LoadingScreen({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center gap-4 py-10 text-center text-base-content/70"
      role="status"
    >
      <span className="loading loading-spinner loading-lg" aria-hidden="true" />
      <p className="text-sm">{label}</p>
    </div>
  )
}

export function GitHubAuthCard() {
  const { t } = useTranslation()
  useDocumentTitle(t("auth.signInTitle"))
  const auth = useGithubAuth()

  return (
    <main className="flex min-h-screen items-center justify-center bg-base-200 px-4 py-8">
      <section className="card relative w-full max-w-lg rounded-xl border border-base-300 bg-base-100 shadow-sm">
        <div className="absolute right-3 top-3 z-10">
          <LoginLanguageMenu />
        </div>
        <header className="flex items-center gap-4 border-b border-base-200 px-7 py-6">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <GraduationCap aria-hidden="true" className="size-6" />
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

        <div className="card-body">
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
          ) : (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault()
                void auth.startWebFlow()
              }}
            >
              {auth.error ? (
                <div className="alert alert-error items-start text-sm">
                  <AlertTriangle
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                  <span>{auth.error}</span>
                </div>
              ) : auth.sessionExpired ? (
                <div className="alert alert-warning items-start text-sm">
                  <AlertTriangle
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                  <span>Your session expired — sign in again to continue.</span>
                </div>
              ) : null}

              <div className="space-y-3">
                <button
                  className="btn btn-primary w-full"
                  type="submit"
                  disabled={auth.isStartingWebFlow}
                >
                  {auth.isStartingWebFlow ? (
                    <span
                      className="loading loading-spinner loading-sm"
                      aria-hidden="true"
                    />
                  ) : (
                    <GitHub aria-hidden="true" className="size-4" />
                  )}
                  {t("auth.signInWithGitHub")}
                </button>

                <button
                  className="btn btn-outline btn-primary w-full"
                  type="button"
                  disabled={auth.isRequestingDeviceCode}
                  onClick={() => void auth.startDeviceFlow()}
                >
                  {auth.isRequestingDeviceCode ? (
                    <span
                      className="loading loading-spinner loading-sm"
                      aria-hidden="true"
                    />
                  ) : null}
                  {t("auth.useDeviceCode")}
                </button>
              </div>
            </form>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-base-200 px-7 py-4 text-xs text-base-content/70">
          <span>{t("auth.footerTagline")}</span>
          <div className="flex shrink-0 items-center gap-3">
            <AppVersionBadge className="tabular-nums text-base-content/50" />
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
      </section>
    </main>
  )
}
