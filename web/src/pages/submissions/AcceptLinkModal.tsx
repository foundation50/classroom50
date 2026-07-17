import { ChevronRight, LinkIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { CopyableCode, Modal, rtlFlip } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

// The "How students accept" content, moved out of the page into a modal so the
// roster surfaces higher. Owns its own clipboard state (two independent copy
// buttons) so the page stays uninvolved.
export function AcceptLinkModal({
  open,
  onClose,
  url,
  cli,
  hasSecret,
}: {
  open: boolean
  onClose: () => void
  url: string
  cli: string
  hasSecret: boolean
}) {
  const { t } = useTranslation()
  const { copied: copiedUrl, copy: copyUrl } = useCopyToClipboard(url, 1500)
  const { copied: copiedCli, copy: copyCli } = useCopyToClipboard(cli, 1500)

  return (
    <Modal open={open} onClose={onClose} size="2xl">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
          <LinkIcon aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold">
            {t("submissions.accept.heading")}
          </h3>
          <p className="text-sm text-base-content/70">
            {t("submissions.accept.subheading")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {hasSecret ? (
          <p className="text-sm text-base-content/70">
            {t("submissions.accept.unlistedNote")}
          </p>
        ) : null}

        <CopyableCode
          value={url}
          copied={copiedUrl}
          onCopy={copyUrl}
          label={t("submissions.accept.copyLink")}
        />

        <details className="group/cli">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm text-base-content/70 hover:text-base-content">
            <ChevronRight
              aria-hidden="true"
              className={`size-4 transition-transform ${rtlFlip} group-open/cli:rotate-90`}
            />
            {t("submissions.accept.preferCli")}
          </summary>
          <CopyableCode
            className="mt-2"
            value={cli}
            copied={copiedCli}
            onCopy={copyCli}
            label={t("submissions.accept.copyCli")}
          />
        </details>
      </div>
    </Modal>
  )
}

export default AcceptLinkModal
