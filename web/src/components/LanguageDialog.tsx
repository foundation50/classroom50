import { forwardRef } from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"

import { LanguageSwitcher } from "@/components/settings/LanguageSwitcher"

// Language-pack modal shown from the sidebar footer. Extracted alongside
// AboutDialog (same forwardRef<HTMLDialogElement> shape) so the sidebar footer
// wires two consistent portalled dialogs rather than inlining one and importing
// the other. Closing on apply is driven by the same ref the caller opens with.
export const LanguageDialog = forwardRef<
  HTMLDialogElement,
  { titleId: string }
>(function LanguageDialog({ titleId }, ref) {
  const { t } = useTranslation()

  // Close via the forwarded ref once a pack is applied. The ref is a
  // MutableRefObject here (the caller passes useRef), so read .current; guard
  // the RefCallback shape defensively.
  const close = () => {
    if (typeof ref === "object" && ref !== null) {
      ref.current?.close()
    }
  }

  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId}>
      <div className="modal-box flex max-h-[85vh] max-w-lg flex-col overflow-y-auto text-base-content">
        <form method="dialog">
          <button
            className="btn btn-sm btn-circle btn-ghost absolute right-3 top-3"
            aria-label={t("common.close")}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </form>
        <h3 id={titleId} className="text-lg font-bold">
          {t("nav.languageDialogTitle")}
        </h3>
        <p className="mt-1 mb-4 text-sm text-base-content/70">
          {t("nav.languageDialogDescription")}
        </p>
        <LanguageSwitcher onApplied={close} />
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>{t("common.close")}</button>
      </form>
    </dialog>
  )
})
