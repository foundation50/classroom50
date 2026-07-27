import { useTranslation } from "react-i18next"
import { Select } from "@/components/ui"
import type { ImportRosterRow } from "@/domain/students"
import type { ClassroomRole } from "@/util/teamRoster"
import {
  ROLE_LABEL_KEY,
  METADATA_FIELD_LABEL_KEY,
} from "@/util/classroomRoleUI"
import type { MetadataField } from "@/util/rosterMetadataMerge"
import type { MetadataChange } from "@/util/rosterUploadPreflight"
import { coerceImportRole } from "./rosterImportParse"

// Per-username metadata changes the preflight detected (from metadata_update or
// role_change outcomes), keyed by lowercased username. Drives the cell
// highlighting + hover tooltips in the preview so the teacher sees exactly which
// values the import will overwrite, in place, rather than in a separate list.
export type RowChanges = Record<string, MetadataChange[]>

// Per-username role change (current -> CSV role), keyed by lowercased username,
// so the Role cell highlights consistently with the metadata cells.
export type RowRoleChanges = Record<
  string,
  { from: ClassroomRole; to: ClassroomRole }
>

// Shared highlight classes so a changed metadata cell and a changed role cell
// read identically (single source — no drift between the two columns).
const CHANGED_CELL_CLASS =
  "bg-warning/25 font-semibold text-base-content ring-1 ring-inset ring-warning/50"
const CHANGED_TOOLTIP_CLASS =
  "tooltip tooltip-warning cursor-help whitespace-pre-line"

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
    <td className={CHANGED_CELL_CLASS}>
      <span
        className={`${CHANGED_TOOLTIP_CLASS} decoration-warning decoration-dotted underline underline-offset-2`}
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
  roleChanges = {},
  loading = false,
}: {
  rows: ImportRosterRow[]
  rolesByUser: Record<string, ClassroomRole>
  onRoleChange: (usernameKey: string, role: ClassroomRole) => void
  changes?: RowChanges
  roleChanges?: RowRoleChanges
  // While the preflight resolves, the per-cell changes aren't known yet: render
  // the change-bearing columns (name/email/section/role) as skeletons to signal
  // "computing changes" in place, rather than briefly showing static values that
  // then sprout highlights.
  loading?: boolean
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
          {loading
            ? rows.map((row, index) => (
                <tr key={row.username.toLowerCase()}>
                  <td>{index + 1}</td>
                  <td>
                    <code>{row.username}</code>
                  </td>
                  {/* Name / Email / Section / Role skeletons: their change state
                      is still being resolved. */}
                  <td>
                    <div className="skeleton skeleton-shimmer h-4 w-28" />
                  </td>
                  <td>
                    <div className="skeleton skeleton-shimmer h-4 w-40" />
                  </td>
                  <td>
                    <div className="skeleton skeleton-shimmer h-4 w-16" />
                  </td>
                  <td>
                    <div className="skeleton skeleton-shimmer h-8 w-32" />
                  </td>
                </tr>
              ))
            : rows.map((row, index) => {
                const key = row.username.toLowerCase()
                const rowChanges = changes[key] ?? []
                const roleChange = roleChanges[key]
                const changed = rowChanges.length > 0 || Boolean(roleChange)
                return (
                  <tr
                    key={key}
                    className={changed ? "bg-warning/10" : undefined}
                  >
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
                    <td className={roleChange ? CHANGED_CELL_CLASS : undefined}>
                      {/* Highlight the cell like the other changed columns, but show
                      the role change as an inline "was <role>" hint rather than a
                      hover tooltip — a tooltip fights the native Select dropdown
                      and overlaps it. The Select already shows the new role. */}
                      <div className="flex flex-col gap-0.5">
                        <Select
                          selectSize="xs"
                          className="w-32"
                          aria-label={t("students.assignRoleLabel")}
                          value={rolesByUser[key] ?? "student"}
                          onChange={(e) => {
                            // Read the value synchronously — React nulls the event's
                            // currentTarget after the handler returns, so a deferred
                            // setState updater must not touch `e`.
                            const role =
                              coerceImportRole(e.target.value) ?? "student"
                            onRoleChange(key, role)
                          }}
                        >
                          <option value="student">
                            {t("students.roleStudent")}
                          </option>
                          <option value="ta">{t("students.roleTa")}</option>
                          <option value="hta">
                            {t("students.roleHeadTa")}
                          </option>
                          <option value="teacher">
                            {t("students.roleTeacher")}
                          </option>
                        </Select>
                        {roleChange ? (
                          <span className="text-xs opacity-70">
                            {t("students.rolePreviousHint", {
                              role: t(ROLE_LABEL_KEY[roleChange.from]),
                            })}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
        </tbody>
      </table>
    </div>
  )
}
