import { useId } from "react"
import { useTranslation } from "react-i18next"

import { Button, Modal } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { buildDiagnostics } from "@/lib/diagnostics/snapshot"
import { Check, ClipboardCopy } from "lucide-react"

// Modal presenting the allow-listed diagnostics snapshot with a copy-to-clipboard
// action. Nothing is sent anywhere — copy only. The snapshot is rebuilt each open
// so the recent-error tail is current; buildDiagnostics is pure and cheap.
export function DiagnosticsDialog({
  open,
  onClose,
  org,
  planName,
}: {
  open: boolean
  onClose: () => void
  org?: string | null
  planName?: string
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const text = buildDiagnostics({ org, planName })
  const { copied, copy } = useCopyToClipboard(text)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      boxClassName="flex max-h-[85vh] flex-col overflow-y-auto text-base-content"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="text-lg font-bold">
        {t("orgActivity.diagnostics.title")}
      </h3>
      <p className="mt-1 mb-4 text-sm text-base-content/70">
        {t("orgActivity.diagnostics.description")}
      </p>

      <pre className="overflow-auto rounded-lg bg-base-100 p-3 text-xs whitespace-pre-wrap">
        {text}
      </pre>

      <div className="mt-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <ClipboardCopy aria-hidden="true" className="size-4" />
          )}
          {copied
            ? t("orgActivity.diagnostics.copied")
            : t("orgActivity.diagnostics.copy")}
        </Button>
      </div>
    </Modal>
  )
}

export default DiagnosticsDialog
