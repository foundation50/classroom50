import { useTranslation } from "react-i18next"
import { Select } from "@/components/ui"
import type { ImportRosterRow } from "@/domain/students"
import type { ClassroomRole } from "@/util/teamRoster"
import { coerceImportRole } from "./rosterImportParse"

// The parsed-roster preview: one row per deduped username with its name/email/
// section and an editable role Select (seeded from the CSV role column). Role
// edits bubble up so the parent can re-run the preflight.
export const RosterPreviewTable = ({
  rows,
  rolesByUser,
  onRoleChange,
}: {
  rows: ImportRosterRow[]
  rolesByUser: Record<string, ClassroomRole>
  onRoleChange: (usernameKey: string, role: ClassroomRole) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="max-h-80 overflow-auto rounded-box border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{t("students.githubUsernameColumn")}</th>
            <th scope="col">{t("students.nameColumn")}</th>
            <th scope="col">{t("students.emailColumn")}</th>
            <th scope="col">{t("students.sectionColumn")}</th>
            <th scope="col">{t("students.roleColumn")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = row.username.toLowerCase()
            return (
              <tr key={key}>
                <td>{index + 1}</td>
                <td>
                  <code>{row.username}</code>
                </td>
                <td className="opacity-70">
                  {[row.first_name, row.last_name].filter(Boolean).join(" ")}
                </td>
                <td className="opacity-70">{row.email}</td>
                <td className="opacity-70">{row.section}</td>
                <td>
                  <Select
                    selectSize="xs"
                    className="w-32"
                    aria-label={t("students.assignRoleLabel")}
                    value={rolesByUser[key] ?? "student"}
                    onChange={(e) => {
                      // Read the value synchronously — React nulls the event's
                      // currentTarget after the handler returns, so a deferred
                      // setState updater must not touch `e`.
                      const role = coerceImportRole(e.target.value) ?? "student"
                      onRoleChange(key, role)
                    }}
                  >
                    <option value="student">{t("students.roleStudent")}</option>
                    <option value="ta">{t("students.roleTa")}</option>
                    <option value="instructor">
                      {t("students.roleInstructor")}
                    </option>
                  </Select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
