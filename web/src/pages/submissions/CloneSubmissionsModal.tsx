import { ChevronRightIcon, TerminalIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"

import { CopyableCode, Heading, Modal, rtlFlip } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

// Published extension repo (see CONTRIBUTING.md "Distribution"), where
// `gh extension install` resolves the teacher CLI.
const INSTALL_CLI = "gh extension install foundation50/gh-teacher"

// Shows the `gh teacher download` command that clones every student repo for
// this assignment — the CLI counterpart of the in-browser zip download, for
// teachers who grade locally with git. Owns its own clipboard state (two
// independent copy buttons) so the page stays uninvolved.
export function CloneSubmissionsModal({
  open,
  onClose,
  cli,
}: {
  open: boolean
  onClose: () => void
  cli: string
}) {
  const { t } = useTranslation()
  const { copied: copiedCli, copy: copyCli } = useCopyToClipboard(cli, 1500)
  const { copied: copiedInstall, copy: copyInstall } = useCopyToClipboard(
    INSTALL_CLI,
    1500,
  )

  return (
    <Modal open={open} onClose={onClose} size="2xl">
      <div className="flex items-start gap-3">
        <div className="rounded-box bg-primary/10 p-2.5 text-primary">
          <TerminalIcon aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <Heading as="h3">{t("submissions.cloneAll.heading")}</Heading>
          <p className="text-sm text-base-content/70">
            {t("submissions.cloneAll.subheading")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <CopyableCode
          value={cli}
          copied={copiedCli}
          onCopy={copyCli}
          label={t("submissions.cloneAll.copyCli")}
          copiedLabel={t("submissions.cloneAll.copied")}
        />

        <details className="group/install">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm text-base-content/70 hover:text-base-content">
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-4 transition-transform ${rtlFlip} group-open/install:rotate-90`}
            />
            {t("submissions.cloneAll.needCli")}
          </summary>
          <p className="mt-2 text-sm text-base-content/70">
            {t("submissions.cloneAll.installHint")}
          </p>
          <CopyableCode
            className="mt-2"
            value={INSTALL_CLI}
            copied={copiedInstall}
            onCopy={copyInstall}
            label={t("submissions.cloneAll.copyInstall")}
            copiedLabel={t("submissions.cloneAll.copied")}
          />
        </details>
      </div>
    </Modal>
  )
}

export default CloneSubmissionsModal
