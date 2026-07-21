import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Info } from "lucide-react"

import { Alert } from "@/components/ui"
import { RoleBadges } from "./RoleBadges"
import { coerceImportRole } from "./rosterImportParse"
import type { Student } from "@/types/classroom"

function displayName(student: Student): string {
  const full = `${student.first_name} ${student.last_name}`.trim()
  return full || student.username
}

// The read-only "CSV roster" for a non-owner staffer (TA / head TA), sourced
// from the config repo's roster.csv rather than GitHub team membership. A TA/HTA
// isn't on the classroom's secret student team, so the team-members API 403s for
// them — roster.csv (readable via config-repo access) is the stand-in:
// teacher-maintained, not live, no invites or management actions.
const CsvRosterView = ({ students }: { students: Student[] }) => {
  const { t } = useTranslation()

  const rows = useMemo(
    () =>
      [...students].sort((a, b) =>
        displayName(a).localeCompare(displayName(b)),
      ),
    [students],
  )

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">
        <Info aria-hidden="true" className="size-5" />
        <span>{t("students.csvRoster.notice")}</span>
      </Alert>

      <div className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
        <table className="table">
          <caption className="sr-only">
            {t("students.csvRoster.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("students.csvRoster.colName")}</th>
              <th scope="col">{t("students.csvRoster.colSection")}</th>
              <th scope="col">{t("students.csvRoster.colRole")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center">
                  {t("students.csvRoster.empty")}
                </td>
              </tr>
            ) : (
              rows.map((student) => (
                <tr key={student.username || student.github_id}>
                  <td>
                    <div className="font-bold">{displayName(student)}</div>
                    {student.username ? (
                      <div className="font-mono text-xs text-base-content/70">
                        {student.username}
                      </div>
                    ) : null}
                  </td>
                  <td>{student.section || "—"}</td>
                  <td>
                    <RoleBadges
                      roles={[coerceImportRole(student.role) ?? "student"]}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default CsvRosterView
