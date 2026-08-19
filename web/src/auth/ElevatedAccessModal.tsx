import { ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "./useGithubAuth"
import { GitHubDevicePrompt } from "./GitHubDevicePrompt"
import { Button, Modal } from "@/components/ui"

// Elevation re-auth for a signed-in teacher who needs a destructive action
// (Teardown Organization) that the least-privilege sign-in doesn't cover.
//
// Two paths, because the browser redirect can't complete on localhost (the
// OAuth callback URL is the deployed origin): "Continue in browser" runs the
// standard redirect flow (production), and "Use a device code" runs the device
// flow inline in this modal (works anywhere, including local development). Both
// request the elevated scope for this one re-auth only.
export function ElevatedAccessModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { startWebFlow, startDeviceFlow, screen, device, deviceStatus } =
    useGithubAuth()

  const showingDevice = screen === "device-prompt" && !!device

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      aria-label={t("auth.elevated.title")}
    >
      {showingDevice ? (
        <GitHubDevicePrompt
          device={device}
          status={deviceStatus}
          onCancel={onClose}
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
              <h2 className="text-lg font-semibold">
                {t("auth.elevated.title")}
              </h2>
              <p className="mt-1 text-sm text-base-content/70">
                {t("auth.elevated.body")}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void startWebFlow({ elevated: true })}
            >
              {t("auth.elevated.browserButton")}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void startDeviceFlow({ elevated: true })}
            >
              {t("auth.elevated.deviceButton")}
            </Button>
            <p className="text-xs leading-relaxed text-base-content/60">
              {t("auth.elevated.deviceHint")}
            </p>
          </div>
        </div>
      )}
    </Modal>
  )
}
