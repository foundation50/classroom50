import { useMemo, useState } from "react"
import { EmptyState } from "@/components/list"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "@/components/ui/icons"

import { Alert, SkeletonRows, Toolbar } from "@/components/ui"
import { RoleBadges } from "./RoleBadges"
import { StudentSortSelect } from "./StudentSortSelect"
import { coerceImportRole } from "./rosterImportParse"
import type { Student } from "@/types/classroom"
import { studentKey } from "@/util/identity"
import {
  DEFAULT_STUDENT_SORT,
  sortStudentsByName,
  type StudentSortMode,
} from "@/util/students"

function displayName(student: Student): string {
  const full = `${student.first_name} ${student.last_name}`.trim()
  // Fall back to the address for a pending email invite: it carries no username,
  // and without this the row renders completely blank.
  return full || student.username || student.email
}

// The read-only "CSV roster" for a non-owner staffer (TA / head TA), sourced
// from the config repo's roster.csv rather than GitHub team membership. A TA/HTA
// isn't on the classroom's secret student team, so the team-members API 403s for
// them — roster.csv (readable via config-repo access) is the stand-in:
// teacher-maintained, not live, no invites or management actions.
const CsvRosterView = ({
  students,
  loading = false,
}: {
  students: Student[]
  // Hold skeleton rows while roster.csv loads — the empty-while-loading array
  // is indistinguishable from a genuinely empty roster, so rendering on it
  // flashes the "empty roster" row.
  loading?: boolean
}) => {
  const { t } = useTranslation()
  const [sortMode, setSortMode] =
    useState<StudentSortMode>(DEFAULT_STUDENT_SORT)

  const rows = useMemo(
    () => sortStudentsByName(students, sortMode),
    [students, sortMode],
  )

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">
        <InfoIcon aria-hidden="true" className="size-4" />
        <span>{t("students.csvRoster.notice")}</span>
      </Alert>

      {students.length > 0 ? (
        <Toolbar>
          <StudentSortSelect value={sortMode} onChange={setSortMode} />
        </Toolbar>
      ) : null}

      <div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
        <table className="table" aria-busy={loading || undefined}>
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
            {loading ? (
              <SkeletonRows rows={3} bars={["w-40", "w-16", "w-20"]} />
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <EmptyState
                    variant="bare"
                    body={t("students.csvRoster.empty")}
                  />
                </td>
              </tr>
            ) : (
              rows.map((student) => (
                // studentKey falls back to the email, so two pending invites
                // don't collide on an empty key.
                <tr key={studentKey(student)}>
                  <td>
                    <div className="font-bold">{displayName(student)}</div>
                    {student.username ? (
                      <div className="font-mono text-xs text-base-content/70">
                        {student.username}
                      </div>
                    ) : student.email ? (
                      <div className="text-xs text-base-content/70">
                        {t("students.csvRoster.invitePending")}
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
