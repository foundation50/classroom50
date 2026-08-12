import type { ReactNode } from "react"
import { RotateCcw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button, Card } from "@/components/ui"

// One card wrapper for every top-level section: a bold heading, an optional
// per-section Reset control, an optional description, and the section body.
// Keeps the five sections visually uniform. The Reset control appears only when
// the caller passes `onReset` (create mode, and the section differs from its
// defaults); clicking it restores that section to its default settings.
export function SectionCard({
  title,
  description,
  onReset,
  children,
}: {
  title: string
  description?: string
  // When provided, render a Reset control in the header. Omitted (undefined)
  // means the section is unchanged or resetting isn't offered (edit mode).
  onReset?: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Card bordered={false} className="w-full mb-6">
      <Card.Body>
        <div className="flex items-center justify-between gap-3 pb-1">
          <h3 className="text-lg font-bold">{title}</h3>
          {onReset ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              aria-label={t("assignments.form.resetSection")}
              title={t("assignments.form.resetSection")}
              className="shrink-0 gap-1.5 text-base-content/60 hover:text-base-content"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              {t("assignments.form.reset")}
            </Button>
          ) : null}
        </div>
        {description ? (
          <p className="mb-3 text-sm text-base-content/70">{description}</p>
        ) : null}
        {children}
      </Card.Body>
    </Card>
  )
}
