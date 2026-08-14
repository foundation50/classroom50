import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"

// The collapsible "Advanced settings" disclosure shared by the Repository Setup
// and autograder panes. One recipe, one source — both render through this so the
// chevron/heading treatment can't drift. Deliberately compact and info-colored
// rather than heading-sized: it's a secondary affordance the common path skips.
export function CollapsibleAdvanced({
  help,
  children,
}: {
  help?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer items-center gap-1.5 text-sm font-semibold text-info marker:content-none hover:underline">
        <ChevronRight
          aria-hidden="true"
          className="size-4 transition-transform group-open:rotate-90"
        />
        {t("assignments.form.advanced")}
      </summary>
      {help ? (
        <p className="pt-2 pb-4 text-sm text-base-content/70">{help}</p>
      ) : (
        <div className="pt-2" />
      )}
      {children}
    </details>
  )
}
