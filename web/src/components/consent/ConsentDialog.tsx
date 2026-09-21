import { useTranslation } from "react-i18next"

import { Modal, ModalIcon } from "@/components/ui"
import { ShieldCheckIcon } from "@/components/ui/icons"
import { useConsent } from "@/context/consent/ConsentProvider"
import { router } from "@/router"

import { ConsentPreferencesForm } from "./ConsentPreferencesForm"

// The "Customize" dialog. Mounted once app-wide (see main.tsx) and opened from
// the banner, Settings, or /privacy through the consent context. The form is
// keyed on `dialogOpen` so each opening starts from the saved record.
export function ConsentDialog() {
  const { t } = useTranslation()
  const { dialogOpen, closeDialog } = useConsent()

  return (
    <Modal
      open={dialogOpen}
      onClose={closeDialog}
      size="md"
      title={t("consent.dialog.title")}
      subtitle={t("consent.dialog.subtitle")}
      headerVisual={
        <ModalIcon tone="primary">
          <ShieldCheckIcon aria-hidden="true" className="size-5" />
        </ModalIcon>
      }
    >
      <div className="mt-4 flex flex-col gap-4">
        {dialogOpen && <ConsentPreferencesForm idPrefix="consent-dialog" />}
        <p className="text-xs text-base-content/60">
          {t("consent.dialog.footnote")}{" "}
          <a
            href="/privacy"
            className="link link-info link-hover"
            onClick={(event) => {
              event.preventDefault()
              closeDialog()
              void router.navigate({ to: "/privacy" })
            }}
          >
            {t("consent.privacyLink")}
          </a>
        </p>
      </div>
    </Modal>
  )
}
