import { forwardRef } from "react"
import { useTranslation } from "react-i18next"

import { Modal } from "@/components/ui"
import { LanguageSwitcher } from "@/components/settings/LanguageSwitcher"

// Language-pack modal shown from the sidebar footer. Extracted alongside
// AboutDialog (same forwardRef<HTMLDialogElement> shape) so the footer wires two
// consistent portalled dialogs. Closing on apply uses the caller's open ref.
export const LanguageDialog = forwardRef<HTMLDialogElement, object>(
  function LanguageDialog(_props, ref) {
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
        title={t("nav.languageDialogTitle")}
        subtitle={t("nav.languageDialogDescription")}
      >
        <div className="mt-4">
          <LanguageSwitcher onApplied={close} />
        </div>
      </Modal>
    )
  },
)
