import { useTranslation } from "react-i18next"
import { Badge, Select, SkeletonCell } from "@/components/ui"
import type { ClassroomRole } from "@/util/teamRoster"
import {
  ROLE_LABEL_KEY,
  METADATA_FIELD_LABEL_KEY,
} from "@/util/classroomRoleUI"
import type { MetadataField } from "@/util/rosterMetadataMerge"
import type { MetadataChange } from "@/util/rosterUploadPreflight"
import {
  identityKey,
  type ResolvedImportRow,
} from "@/pages/students/rosterImportResolve"
import { coerceImportRole } from "./rosterImportParse"

// Per-row metadata changes the preflight detected (from metadata_update or
// role_change outcomes), keyed by identityKey. Drives the cell highlighting +
// hover tooltips in the preview so the teacher sees exactly which values the
// import will overwrite, in place, rather than in a separate list.
export type RowChanges = Record<string, MetadataChange[]>

// Per-row role change (current -> CSV role), keyed by identityKey, so the Role
// cell highlights consistently with the metadata cells.
export type RowRoleChanges = Record<
  string,
  { from: ClassroomRole; to: ClassroomRole }
>

// Per-row identity mismatch (the username the FILE declared -> the login its
// github_id actually resolves to), keyed by identityKey. Deliberately NOT routed
// through MetadataChange: username is not a MetadataField, and threading it
// through the metadata machinery would leak a non-metadata field into
// mergeStudentMetadata and the metadata label map.
export type RowIdentityChanges = Record<string, { declaredUsername: string }>

// Shared highlight classes so a changed metadata cell, a changed role cell, and a
// corrected username read identically (single source — no drift between columns).
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

// The identity column. An account row shows its login, tinted with an inline
// "was <username>" hint when a github_id corrected it — the same treatment the
// Role column uses for a role change, rather than a hover tooltip a keyboard or
// touch user can't reach. An email row shows an explicit badge instead of a blank
// cell, which would otherwise read as missing data (and announce as nothing at
// all to a screen reader).
const IdentityCell = ({
  row,
  declaredUsername,
  alreadyOnRoster,
}: {
  row: ResolvedImportRow
  declaredUsername?: string
  alreadyOnRoster?: boolean
}) => {
  const { t } = useTranslation()
  if (row.identity.kind === "email") {
    // The address is invited either way; a roster row already carrying it just
    // means no second row is written, and GitHub may answer the invite with a
    // 422 if that person is already a member. Say that rather than implying the
    // row is either a fresh invite or no action at all.
    return (
      <td>
        <Badge tone={alreadyOnRoster ? "neutral" : "info"} size="sm">
          {t(
            alreadyOnRoster
              ? "students.previewEmailOnRoster"
              : "students.previewInviteByEmail",
          )}
        </Badge>
      </td>
    )
  }
  return (
    <td className={declaredUsername ? CHANGED_CELL_CLASS : undefined}>
      <div className="flex flex-col gap-0.5">
        <code>{row.identity.username}</code>
        {declaredUsername ? (
          <span className="text-xs opacity-70">
            {t("students.previewPreviousUsernameHint", {
              username: declaredUsername,
            })}
          </span>
        ) : null}
      </div>
    </td>
  )
}

// The parsed-roster preview: one row per deduped identity with its name/email/
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
  identityChanges = {},
  alreadyOnRosterKeys,
  loading = false,
  skeletonRowCount,
}: {
  rows: ResolvedImportRow[]
  rolesByUser: Record<string, ClassroomRole>
  onRoleChange: (rowKey: string, role: ClassroomRole) => void
  changes?: RowChanges
  roleChanges?: RowRoleChanges
  identityChanges?: RowIdentityChanges
  // Rows the roster already carries the address for. The import still invites
  // them (GitHub decides whether that is redundant), but no second roster row is
  // written, so the identity cell says so instead of implying a fresh invite.
  alreadyOnRosterKeys?: ReadonlySet<string>
  // While the preflight resolves, the per-cell changes aren't known yet: render
  // the change-bearing columns as skeletons to signal "computing changes" in
  // place, rather than briefly showing static values that then sprout highlights.
  // The identity column is change-bearing too now (a github_id can correct a
  // stale login), so it skeletons with the rest.
  loading?: boolean
  // How many placeholder rows to draw while loading. Identities aren't resolved
  // yet at that point, so `rows` is empty and the caller passes the parsed count.
  skeletonRowCount?: number
}) => {
  const { t } = useTranslation()
  const skeletonRows = Array.from({
    length: skeletonRowCount ?? rows.length,
  })
  return (
    <div className="max-h-80 overflow-auto rounded-box border border-base-300">
      <table className="table table-sm" aria-busy={loading}>
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
            ? skeletonRows.map((_, index) => (
                // Decorative loading placeholder — hidden from assistive tech.
                <tr key={`skeleton-${index}`} aria-hidden="true">
                  <td>{index + 1}</td>
                  <SkeletonCell bar="h-4 w-24" />
                  <SkeletonCell bar="h-4 w-28" />
                  <SkeletonCell bar="h-4 w-40" />
                  <SkeletonCell bar="h-4 w-16" />
                  <SkeletonCell bar="h-8 w-32" />
                </tr>
              ))
            : rows.map((row, index) => {
                const key = identityKey(row.identity)
                const rowChanges = changes[key] ?? []
                const roleChange = roleChanges[key]
                const identityChange = identityChanges[key]
                const changed =
                  rowChanges.length > 0 ||
                  Boolean(roleChange) ||
                  Boolean(identityChange)
                return (
                  <tr
                    key={key}
                    className={changed ? "bg-warning/10" : undefined}
                  >
                    <td>{index + 1}</td>
                    <IdentityCell
                      row={row}
                      declaredUsername={identityChange?.declaredUsername}
                      alreadyOnRoster={alreadyOnRosterKeys?.has(key)}
                    />
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
