import { ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "./useGithubAuth"
import { GitHubDevicePrompt } from "./GitHubDevicePrompt"
import { Button, Modal } from "@/components/ui"

// Re-auth for a signed-in teacher who needs to change their delete_repo access.
// GitHub can't add or drop a single scope client-side, so either direction is a
// full sign-in: `elevated` true requests base + delete_repo, false requests base
// only (dropping delete_repo).
//
// Two paths, because the browser redirect can't complete on localhost (the
// OAuth callback URL is the deployed origin): "Continue in browser" runs the
// standard redirect flow (production), and "Use a device code" runs the device
// flow inline in this modal (works anywhere, including local development).
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
  const { startWebFlow, startDeviceFlow, screen, device, deviceStatus } =
    useGithubAuth()

  const showingDevice = screen === "device-prompt" && !!device

  const title = elevated
    ? t("auth.elevated.title")
    : t("auth.elevated.revokeTitle")
  const body = elevated
    ? t("auth.elevated.body")
    : t("auth.elevated.revokeBody")

  return (
    <Modal open={open} onClose={onClose} size="lg" aria-label={title}>
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
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-base-content/70">{body}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void startWebFlow({ elevated })}
            >
              {t("auth.elevated.browserButton")}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void startDeviceFlow({ elevated })}
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
