import { useTranslation } from "react-i18next"

import { Toolbar } from "@/components/ui"
import type { StudentSortMode } from "@/util/students"

// The by-name sort toggle shared across roster views (enrolled + CSV) and any
// other surface that orders students by first vs last name, so the label,
// options, and StudentSortMode cast live in one place.
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
      selectSize="md"
      className="w-full sm:w-auto"
      aria-label={t("students.sortBy.label")}
      value={value}
      onChange={(e) => onChange(e.target.value as StudentSortMode)}
    >
      <option value="first">{t("students.sortBy.firstName")}</option>
      <option value="last">{t("students.sortBy.lastName")}</option>
    </Toolbar.FilterSelect>
  )
}
