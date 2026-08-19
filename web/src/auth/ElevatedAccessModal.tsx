import { useEffect, useState } from "react"
import { AlertTriangle, ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "./useGithubAuth"
import { GitHubDevicePrompt } from "./GitHubDevicePrompt"
import { githubOAuthGrantUrl } from "./constants"
import { Alert, Button, Modal } from "@/components/ui"

// Re-auth for a signed-in teacher who needs to change their delete_repo access.
// GitHub can't add or drop a single scope client-side, so either direction is a
// full sign-in: `elevated` true requests base + delete_repo, false requests base
// only. See auth/constants.ts for the base/elevated policy.
//
// Two paths, because the browser redirect can't complete on localhost (the
// OAuth callback URL is the deployed origin): "Continue in browser" runs the
// standard redirect flow, and "Use a device code" runs the device flow inline
// here (works anywhere, including local development).
export function ElevatedAccessModal({
  open,
  onClose,
  elevated = true,
}: {
  open: boolean
  onClose: () => void
  elevated?: boolean
}) {
  const { t } = useTranslation()
  const {
    startWebFlow,
    startDeviceFlow,
    cancelDeviceFlow,
    screen,
    device,
    deviceElevated,
    deviceStatus,
    error,
    isRequestingDeviceCode,
  } = useGithubAuth()

  // Freeze the direction while open: the caller derives `elevated` from live
  // scope state, so a mid-flow grant would otherwise flip this dialog to the
  // opposite action under the user's cursor.
  const [frozen, setFrozen] = useState(elevated)
  const [awaitingDevice, setAwaitingDevice] = useState(false)

  useEffect(() => {
    if (open) setFrozen(elevated)
    else setAwaitingDevice(false)
    // Re-freeze only on open; `elevated` changing while open is what we ignore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Only show a pending code that this dialog's direction actually started, so a
  // stale flow from another surface can't render under the wrong label.
  const showingDevice =
    screen === "device-prompt" && !!device && deviceElevated === frozen

  // A device flow we started finished elsewhere (completeSignIn clears device
  // and returns to "authed"), so retire the dialog instead of silently falling
  // back to the choice buttons.
  useEffect(() => {
    if (awaitingDevice && screen === "authed" && !device) {
      setAwaitingDevice(false)
      onClose()
    }
  }, [awaitingDevice, screen, device, onClose])

  const title = frozen
    ? t("auth.elevated.title")
    : t("auth.elevated.revokeTitle")
  const body = frozen ? t("auth.elevated.body") : t("auth.elevated.revokeBody")

  // Dismissing must abort the poll: it lives in the auth provider, not here, so
  // unmounting this dialog would otherwise leave it running (and able to swap
  // the session token) long after the user cancelled.
  const dismiss = () => {
    if (showingDevice) cancelDeviceFlow()
    onClose()
  }

  return (
    <Modal open={open} onClose={dismiss} size="lg" aria-label={title}>
      {showingDevice ? (
        <GitHubDevicePrompt
          device={device}
          status={deviceStatus}
          onCancel={dismiss}
          onCodeCopied={() => {}}
          onVerificationOpened={() => {}}
        />
      ) : (
        <div className="space-y-5">
          <div className="flex gap-4 border-b border-base-200 pb-5">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck aria-hidden="true" className="size-6" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-base-content/70">{body}</p>
            </div>
          </div>

          {error ? (
            <Alert tone="error" className="items-start text-sm">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              <span>{error}</span>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              className="w-full"
              disabled={isRequestingDeviceCode}
              onClick={() =>
                void startWebFlow({
                  elevated: frozen,
                  // Come back to the page the user was working on, not the
                  // dashboard the post-login guard would otherwise pick.
                  returnTo: window.location.pathname + window.location.search,
                })
              }
            >
              {t("auth.elevated.browserButton")}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              loading={isRequestingDeviceCode}
              disabled={isRequestingDeviceCode}
              onClick={() => {
                setAwaitingDevice(true)
                void startDeviceFlow({ elevated: frozen })
              }}
            >
              {t("auth.elevated.deviceButton")}
            </Button>
            <p className="text-xs leading-relaxed text-base-content/60">
              {t("auth.elevated.deviceHint")}
            </p>
            {!frozen && (
              // Signing in narrows this session's token; only GitHub can revoke
              // the one already issued, so point at where that happens.
              <a
                className="link text-xs"
                href={githubOAuthGrantUrl()}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("auth.elevated.revokeLink")}
              </a>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
