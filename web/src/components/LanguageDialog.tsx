import { forwardRef } from "react"
import { useTranslation } from "react-i18next"

import { Modal } from "@/components/ui"
import { LanguageSwitcher } from "@/components/settings/LanguageSwitcher"

// Language-pack modal shown from the sidebar footer. Extracted alongside
// AboutDialog (same forwardRef<HTMLDialogElement> shape) so the footer wires two
// consistent portalled dialogs. Closing on apply uses the caller's open ref.
export const LanguageDialog = forwardRef<
  HTMLDialogElement,
  { titleId: string }
>(function LanguageDialog({ titleId }, ref) {
  const { t } = useTranslation()

  // Close via the forwarded ref once a pack is applied. It's a MutableRefObject
  // here (caller passes useRef), so read .current; guard the RefCallback shape.
  const close = () => {
    if (typeof ref === "object" && ref !== null) {
      ref.current?.close()
    }
  }

  return (
    <Modal
      ref={ref}
      size="lg"
      boxClassName="flex max-h-[85vh] flex-col overflow-y-auto text-base-content"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="text-lg font-bold">
        {t("nav.languageDialogTitle")}
      </h3>
      <p className="mt-1 mb-4 text-sm text-base-content/70">
        {t("nav.languageDialogDescription")}
      </p>
      <LanguageSwitcher onApplied={close} />
    </Modal>
  )
})
