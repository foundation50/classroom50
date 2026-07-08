import { useTranslation } from "react-i18next"
import { TriangleAlert } from "lucide-react"

import type { UnenforcedDefaultItem } from "./orgDefaultsStepData"

// The per-field list of member-privilege settings that need a manual fix, shared
// by the setup step board and the org-policy audit pane so the two can't drift.
// Each row is the setting and its by-hand fix; the `pinned` subset (API accepted
// the write but the value didn't stick on read-back) gets a "set manually" badge,
// since a Fix it / re-run can't change those. Renders nothing when empty.
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
              <span className="ml-1 badge badge-ghost badge-xs align-middle">
                {t("orgSettings.audit.requiresManualFix")}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
