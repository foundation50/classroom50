import { useEffect, useRef, useState } from "react"
import { AlertTriangle, ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "./useGithubAuth"
import { GitHubDevicePrompt } from "./GitHubDevicePrompt"
import { githubOAuthGrantUrl } from "./constants"
import { Alert, Button, Modal } from "@/components/ui"

// Re-auth for a signed-in teacher who needs to change their delete_repo access.
// See auth/constants.ts for the base/elevated policy.
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
    markDeviceCodeCopied,
    markVerificationOpened,
    screen,
    device,
    deviceStatus,
    error,
    isRequestingDeviceCode,
  } = useGithubAuth()

  // Whether a device flow started from this dialog is still live. Set on the
  // click, not on the prompt appearing: between the two, the request is in flight
  // with nothing rendered, and dismissing there would otherwise leave the poll
  // running (able to swap the session token) with no UI.
  const ownsDeviceFlowRef = useRef(false)

  // Whether a device prompt has actually appeared in this dialog. The pre-start
  // state (already signed in, no device yet) is indistinguishable from the
  // post-success state, so success is only detectable as "the prompt we showed
  // went away".
  const [sawDevicePrompt, setSawDevicePrompt] = useState(false)

  useEffect(() => {
    if (!open) setSawDevicePrompt(false)
  }, [open])

  // Only show a pending code for this dialog's direction, so a flow started
  // elsewhere can't render under the wrong label.
  const showingDevice =
    screen === "device-prompt" && !!device && device.elevated === elevated

  useEffect(() => {
    if (showingDevice) setSawDevicePrompt(true)
  }, [showingDevice])

  // Keep the close handler in a ref: both call sites pass an inline arrow and
  // re-render with the volatile auth context, so depending on its identity would
  // re-run the watcher below throughout a device flow.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // The prompt we were showing is gone and we're signed in: the flow completed,
  // so retire the dialog instead of falling back to the choice buttons.
  useEffect(() => {
    if (sawDevicePrompt && !showingDevice && screen === "authed") {
      ownsDeviceFlowRef.current = false
      onCloseRef.current()
    }
  }, [sawDevicePrompt, showingDevice, screen])

  // Abandoning the dialog by navigating away never runs `dismiss`, so release an
  // owned flow here too.
  useEffect(
    () => () => {
      if (ownsDeviceFlowRef.current) cancelDeviceFlow()
    },
    [cancelDeviceFlow],
  )

  const title = elevated
    ? t("auth.elevated.title")
    : t("auth.elevated.revokeTitle")
  const body = elevated
    ? t("auth.elevated.body")
    : t("auth.elevated.revokeBody")

  // Dismissing must abort the poll: it lives in the auth provider, not here, so
  // unmounting this dialog would otherwise leave it running (and able to swap
  // the session token) long after the user cancelled.
  const dismiss = () => {
    if (ownsDeviceFlowRef.current) cancelDeviceFlow()
    ownsDeviceFlowRef.current = false
    onClose()
  }

  return (
    <Modal open={open} onClose={dismiss} size="lg" aria-label={title}>
      {showingDevice ? (
        <GitHubDevicePrompt
          device={device}
          status={deviceStatus}
          onCancel={dismiss}
          onCodeCopied={markDeviceCodeCopied}
          onVerificationOpened={markVerificationOpened}
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
              variant={elevated ? "warning" : "primary"}
              className="w-full"
              disabled={isRequestingDeviceCode}
              onClick={() =>
                void startWebFlow({
                  elevated,
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
                ownsDeviceFlowRef.current = true
                void startDeviceFlow({ elevated })
              }}
            >
              {t("auth.elevated.deviceButton")}
            </Button>
            <p className="text-xs leading-relaxed text-base-content/60">
              {t("auth.elevated.deviceHint")}
            </p>
            {!elevated && (
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
