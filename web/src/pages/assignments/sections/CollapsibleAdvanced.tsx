import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"

// The collapsible "Advanced settings" disclosure shared by the Repository Setup
// and Autograding sections: a native <details>/<summary> with a rotating
// chevron. One recipe, one source — both advanced panes render through this so
// the caret/heading treatment can't drift between them. Styled as a compact,
// info-colored toggle (not a section-sized heading) so it reads as a secondary
// affordance the common path can ignore. `title` defaults to the shared
// "Advanced settings" label; `help` is an optional one-line description shown
// when open.
export function CollapsibleAdvanced({
  title,
  help,
  children,
}: {
  title?: string
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
        {title ?? t("assignments.form.advanced")}
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
