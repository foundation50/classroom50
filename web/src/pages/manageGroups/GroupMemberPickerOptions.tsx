import { useTranslation } from "react-i18next"

import {
  partitionGroupPickerStudents,
  type GroupPickerStudent,
} from "@/hooks/useGroupRoster"

// The <option>s of a group add-member picker: students first, then teaching
// staff under their own group label so a TA placed in a group (to test the
// assignment) is a deliberate pick, never mistaken for a student. Shared by
// the manage, copy, and recreate dialogs so the three pickers can't drift.
export function GroupMemberPickerOptions({
  pool,
}: {
  pool: readonly GroupPickerStudent[]
}) {
  const { t } = useTranslation()
  const { students, staff } = partitionGroupPickerStudents(pool)
  return (
    <>
      {students.map((entry) => (
        <option key={entry.key} value={entry.username}>
          {entry.label}
        </option>
      ))}
      {staff.length > 0 && (
        <optgroup label={t("manageGroups.staffPickerGroup")}>
          {staff.map((entry) => (
            <option key={entry.key} value={entry.username}>
              {entry.label}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )
}

export default GroupMemberPickerOptions
