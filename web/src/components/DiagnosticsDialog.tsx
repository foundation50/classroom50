import { useTranslation } from "react-i18next"

import { Button, Modal } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { buildDiagnostics } from "@/lib/diagnostics/snapshot"
import { CheckIcon, CopyIcon } from "@/components/ui/icons"

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
  const text = buildDiagnostics({ org, planName })
  const { copied, copy } = useCopyToClipboard(text)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      boxClassName="flex max-h-[85vh] flex-col overflow-y-auto text-base-content"
      title={t("orgActivity.diagnostics.title")}
      subtitle={t("orgActivity.diagnostics.description")}
      footer={
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? (
            <CheckIcon aria-hidden="true" className="size-4" />
          ) : (
            <CopyIcon aria-hidden="true" className="size-4" />
          )}
          {copied
            ? t("orgActivity.diagnostics.copied")
            : t("orgActivity.diagnostics.copy")}
        </Button>
      }
    >
      <pre className="mt-4 overflow-auto rounded-field bg-base-100 p-3 text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </Modal>
  )
}

export default DiagnosticsDialog
