import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

// The collapsible "Advanced settings" disclosure shared by the Repository Setup
// and Autograding sections: a native <details>/<summary> with a rotating caret.
// One recipe, one source — both advanced panes render through this so the
// caret/heading treatment can't drift between them. `title` defaults to the
// shared "Advanced settings" label; `help` is an optional one-line description
// shown when open.
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
      <summary className="cursor-pointer text-lg font-bold marker:content-none flex items-center gap-2">
        <span className="transition-transform group-open:rotate-90">▶</span>
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
