import { useId } from "react"
import { useTranslation } from "react-i18next"

import { HelpTooltip, Toggle } from "@/components/ui"

// Toolbar switch for counting teaching staff in the assignments table's
// Accepted / Submitted funnel, so a teacher or TA can test an assignment and
// see their own repo land before students are enrolled (#860). Compact label
// recipe (not ToggleField's bold settings row) to sit inline beside Collect all.
export function IncludeStaffToggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
      <Toggle
        id={id}
        size="sm"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm">{t("assignments.includeStaff")}</span>
      <HelpTooltip help={t("assignments.includeStaffHelp")} />
    </label>
  )
}

export default IncludeStaffToggle
