import { useTranslation } from "react-i18next"
import { Select } from "@/components/ui"
import type { ImportRosterRow } from "@/domain/students"
import type { ClassroomRole } from "@/util/teamRoster"
import type { MetadataField } from "@/util/rosterMetadataMerge"
import type { MetadataChange } from "@/util/rosterUploadPreflight"
import { coerceImportRole } from "./rosterImportParse"

// Per-username metadata changes the preflight detected (from metadata_update or
// role_change outcomes), keyed by lowercased username. Drives the cell
// highlighting + hover tooltips in the preview so the teacher sees exactly which
// values the import will overwrite, in place, rather than in a separate list.
export type RowChanges = Record<string, MetadataChange[]>

// i18n label key per updatable metadata field, so the tooltip labels each field.
const METADATA_FIELD_LABEL_KEY: Record<MetadataField, string> = {
  first_name: "students.firstNameColumn",
  last_name: "students.lastNameColumn",
  email: "students.emailColumn",
  section: "students.sectionColumn",
}

// The Name column merges first_name + last_name, so a change to EITHER highlights
// that one cell.
const CELL_FIELDS: Record<"name" | "email" | "section", MetadataField[]> = {
  name: ["first_name", "last_name"],
  email: ["email"],
  section: ["section"],
}

// A preview cell that highlights + tooltips when the import changes its value.
// `changes` is the row's full change list; `cell` selects which metadata fields
// map to this column. When any of those fields changed, the cell is tinted and
// a hover tooltip shows each `stored -> CSV` transition.
const PreviewCell = ({
  value,
  changes,
  cell,
}: {
  value: string
  changes: MetadataChange[]
  cell: keyof typeof CELL_FIELDS
}) => {
  const { t } = useTranslation()
  const fields = CELL_FIELDS[cell]
  const cellChanges = changes.filter((c) => fields.includes(c.field))
  if (cellChanges.length === 0) {
    return <td className="opacity-70">{value}</td>
  }
  const tip = cellChanges
    .map(
      (c) =>
        `${t(METADATA_FIELD_LABEL_KEY[c.field])}: ${
          c.from || t("students.preflightMetadataEmpty")
        } → ${c.to}`,
    )
    .join("\n")
  return (
    <td className="bg-warning/25 font-semibold text-base-content ring-1 ring-inset ring-warning/50">
      <span
        className="tooltip tooltip-warning cursor-help whitespace-pre-line decoration-warning decoration-dotted underline underline-offset-2"
        data-tip={tip}
      >
        {value}
      </span>
    </td>
  )
}

// The parsed-roster preview: one row per deduped username with its name/email/
// section and an editable role Select (seeded from the CSV role column). Role
// edits bubble up so the parent can re-run the preflight. When `changes` marks a
// row, its changed cells are highlighted with a hover tooltip showing the
// stored -> CSV transition, so the import's effect is visible in place.
export const RosterPreviewTable = ({
  rows,
  rolesByUser,
  onRoleChange,
  changes = {},
}: {
  rows: ImportRosterRow[]
  rolesByUser: Record<string, ClassroomRole>
  onRoleChange: (usernameKey: string, role: ClassroomRole) => void
  changes?: RowChanges
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
            const rowChanges = changes[key] ?? []
            const changed = rowChanges.length > 0
            return (
              <tr key={key} className={changed ? "bg-warning/10" : undefined}>
                <td>{index + 1}</td>
                <td>
                  <code>{row.username}</code>
                </td>
                <PreviewCell
                  value={[row.first_name, row.last_name]
                    .filter(Boolean)
                    .join(" ")}
                  changes={rowChanges}
                  cell="name"
                />
                <PreviewCell
                  value={row.email ?? ""}
                  changes={rowChanges}
                  cell="email"
                />
                <PreviewCell
                  value={row.section ?? ""}
                  changes={rowChanges}
                  cell="section"
                />
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
                    <option value="hta">{t("students.roleHeadTa")}</option>
                    <option value="teacher">{t("students.roleTeacher")}</option>
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
