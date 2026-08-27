import { useTranslation } from "react-i18next"

import { Toolbar } from "@/components/ui"
import { ArrowSwitchIcon } from "@/components/ui/icons"
import type { StudentSortMode } from "@/util/students"

// The by-name sort toggle shared across roster views (enrolled + CSV) and any
// other surface that orders students by first vs last name, so the label,
// options, and StudentSortMode cast live in one place. Styled like the
// submissions sort select (sm size, rotated switch icon).
export function StudentSortSelect({
  value,
  onChange,
}: {
  value: StudentSortMode
  onChange: (mode: StudentSortMode) => void
}) {
  const { t } = useTranslation()
  return (
    <Toolbar.FilterSelect
      icon={<ArrowSwitchIcon aria-hidden="true" className="size-4 rotate-90" />}
      aria-label={t("students.sortBy.label")}
      value={value}
      onChange={(e) => onChange(e.target.value as StudentSortMode)}
    >
      <option value="first">{t("students.sortBy.firstName")}</option>
      <option value="last">{t("students.sortBy.lastName")}</option>
    </Toolbar.FilterSelect>
  )
}
