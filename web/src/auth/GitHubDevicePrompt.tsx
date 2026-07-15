import { useEffect, useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { DeviceAuthState } from "./types"
import { Button } from "@/components/ui"

function StepNumber({ value, done }: { value: number; done: boolean }) {
  return (
    <div
      className={[
        "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
        done ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
      ].join(" ")}
    >
      {done ? <Check aria-hidden="true" className="size-4" /> : value}
    </div>
  )
}

export function GitHubDevicePrompt({
  device,
  status,
  onCancel,
  onCodeCopied,
  onVerificationOpened,
}: {
  device: DeviceAuthState
  status: {
    attempts: number
    nextPollSeconds: number
    expiresDisplay: string
  } | null
  onCancel: () => void
  onCodeCopied: () => void
  onVerificationOpened: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [copyTick, setCopyTick] = useState(0)
  const { t } = useTranslation()

  // Reset stale "Copied!" when the code rotates.
  const [copiedCode, setCopiedCode] = useState(device.userCode)
  if (device.userCode !== copiedCode) {
    setCopiedCode(device.userCode)
    if (copied) setCopied(false)
  }

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied, copyTick])

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(device.userCode)
      setCopied(true)
      // Re-arm the reset timer on a repeat click while "Copied!" still shows.
      setCopyTick((t) => t + 1)
      onCodeCopied()
    } catch {
      // ignore: clipboard may be unavailable
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-4 border-b border-base-200 pb-5">
        <StepNumber value={1} done={device.progress >= 1} />

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {t("auth.deviceStep1Title")}
          </h2>

          <div className="my-3 select-all rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-center font-mono text-3xl font-bold tracking-[0.2em]">
            {device.userCode}
          </div>

          <Button
            variant={copied ? "success" : "outline"}
            size="sm"
            className="w-full"
            onClick={copyCode}
          >
            {copied ? (
              <>
                <Check aria-hidden="true" className="size-4" />
                {t("auth.deviceCopied")}
              </>
            ) : (
              <>
                <Copy aria-hidden="true" className="size-4" />
                {t("auth.deviceCopyCode")}
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="flex gap-4 border-b border-base-200 pb-5">
        <StepNumber value={2} done={device.progress >= 2} />

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {t("auth.deviceStep2Title")}
          </h2>

          <Button
            as="a"
            variant="outline"
            size="sm"
            className="mt-3 w-full"
            href={device.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              window.setTimeout(onVerificationOpened, 0)
            }}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {t("auth.deviceOpenUri", { uri: device.verificationUri })}
          </Button>

          <p className="mt-2 text-xs leading-relaxed text-base-content/70">
            {t("auth.deviceStep2Hint")}
          </p>
        </div>
      </div>

      <div className="flex gap-4">
        <StepNumber value={3} done={false} />

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {t("auth.deviceStep3Title")}
          </h2>

          <p className="mt-2 text-xs leading-relaxed text-base-content/70">
            {t("auth.deviceStep3Hint")}
          </p>

          <p className="mt-3 font-mono text-xs text-base-content/70">
            {t("auth.deviceStatus", {
              attempts: status?.attempts ?? device.attempts,
              seconds: status?.nextPollSeconds ?? device.intervalSeconds,
              expires: status?.expiresDisplay ?? "-",
            })}
          </p>
        </div>
      </div>

      <div className="divider" />

      <Button variant="outline" className="w-full" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </div>
  )
}
