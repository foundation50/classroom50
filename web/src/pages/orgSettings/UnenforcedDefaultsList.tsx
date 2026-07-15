import { useTranslation } from "react-i18next"
import { TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui"
import type { UnenforcedDefaultItem } from "./orgDefaultsStepData"

// The per-field list of settings needing a manual fix, shared by the setup step
// board and the audit pane so the two can't drift. Renders nothing when empty.
export const UnenforcedDefaultsList = ({
  items,
}: {
  items: UnenforcedDefaultItem[]
}) => {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <ul className="mt-1 space-y-1">
      {items.map((d) => (
        <li key={d.field} className="flex items-start gap-2 text-xs">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-error"
          />
          <span className="text-base-content/70">
            {d.desc}
            {d.manualFix && (
              <span className="text-base-content/70"> — {d.manualFix}</span>
            )}
            {d.pinned && (
              <Badge size="xs" ghost className="ml-1 align-middle">
                {t("orgSettings.audit.requiresManualFix")}
              </Badge>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
