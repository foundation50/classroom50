import { useTranslation } from "react-i18next"

import { Select } from "@/components/ui"
import type { UploadKind } from "@/pages/students/uploadClassify"

// The "Read the file as" header + format picker. Roster CSV is always the initial
// value and reads all three shapes; the other two are the teacher asserting what
// EVERY line is, which the same parser then honours strictly. One definition so a
// fourth format or a copy change lands in a single place.
export const DetectedFormatSelect = ({
  value,
  onChange,
}: {
  value: UploadKind
  onChange: (kind: UploadKind) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex flex-col gap-1 rounded-box border border-base-300 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-base-content/70">
        {t("students.detectedFormat")}
      </span>
      <Select
        selectSize="sm"
        className="w-full sm:w-64"
        aria-label={t("students.detectedFormat")}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as UploadKind)}
      >
        <option value="roster-csv">{t("students.uploadKindRosterCsv")}</option>
        <option value="username-list">
          {t("students.uploadKindUsernameList")}
        </option>
        <option value="email-list">{t("students.uploadKindEmailList")}</option>
      </Select>
    </div>
  )
}
