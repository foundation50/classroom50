import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Info } from "lucide-react"

import { Alert } from "@/components/ui"
import { RoleBadges } from "./RoleBadges"
import type { Student } from "@/types/classroom"
import type { ClassroomRole } from "@/util/teamRoster"

// Map a roster.csv `role` cell to a ClassroomRole for the badge. The column is
// best-effort metadata (teacher/hta/ta/student, the legacy "instructor", or
// blank), so an unknown/blank value renders as a plain student.
function roleFromCsv(role: string): ClassroomRole {
  switch (role.trim().toLowerCase()) {
    case "teacher":
      return "teacher"
    case "instructor":
      return "instructor"
    case "hta":
      return "hta"
    case "ta":
      return "ta"
    default:
      return "student"
  }
}

function displayName(student: Student): string {
  const full = `${student.first_name} ${student.last_name}`.trim()
  return full || student.username
}

// Read-only roster for a non-owner staffer (TA / head TA), sourced from the
// config repo's roster.csv rather than GitHub team membership. A TA/HTA is a
// plain org member who is NOT on the classroom's secret student team, so the
// team-members API (GET /orgs/{org}/teams/{slug}/members) 403s for them — they
// genuinely can't read the authoritative enrollment. roster.csv (which they can
// read via config-repo access) is a good-enough approximation: teacher-
// maintained, not live, and carrying no pending invites or management actions
// (all owner-only). Owners get the live team-driven EnrolledStudents view.
const RosterApproxView = ({ students }: { students: Student[] }) => {
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
        <span>{t("students.approx.notice")}</span>
      </Alert>

      <div className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
        <table className="table">
          <caption className="sr-only">{t("students.approx.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("students.approx.colName")}</th>
              <th scope="col">{t("students.approx.colSection")}</th>
              <th scope="col">{t("students.approx.colRole")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center">
                  {t("students.approx.empty")}
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
                    <RoleBadges roles={[roleFromCsv(student.role)]} />
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

export default RosterApproxView
