import { useTranslation } from "react-i18next"

import { FilterIcon, RowsIcon, SyncIcon } from "@/components/ui/icons"
import {
  Button,
  HelpTooltip,
  SelectSeparatorOption,
  Toolbar,
  cx,
} from "@/components/ui"
import { formatRelativeToNow } from "@/util/formatDate"
import type { GitHubClient } from "@/github-core/client"
import type { TeamRosterRow, ClassroomRole } from "@/util/teamRoster"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import { NO_SECTION } from "@/pages/students/rosterFilter"
import RosterBulkActionsBar, {
  type AddStudentActions,
} from "@/pages/students/RosterBulkActionsBar"
import AddStudentButtons from "@/pages/students/AddStudentButtons"

export type RosterGrouping = "none" | "role" | "section"

// The enrolled-roster toolbar, one row (mirroring the submissions controls):
// Sync (which doubles as the sync-progress indicator) and the selection
// cluster on the left; search, the combined Show filter, section filter,
// grouping, and the add-students actions on the right. Pure view — every
// piece of state lives in EnrolledStudents, which stays the single owner of
// filters, selection, and the sync run.
export function RosterToolbar({
  org,
  classroom,
  client,
  syncing,
  onSync,
  lastUpdatedAt = null,
  lastSyncChanges = null,
  selectedRows,
  onClearSelection,
  onBulkDone,
  query,
  onQueryChange,
  onClearAllFilters,
  hasActiveFilter,
  hasFilterActive,
  showValue,
  onShowChange,
  statusOptions,
  roleFilterOptions,
  canGroupByRole,
  sectionOptions,
  effectiveSection,
  onSectionChange,
  grouping,
  onGroupingChange,
  addActions,
  onEditRoster,
}: {
  org: string
  classroom: string
  client: GitHubClient
  // True while any sync writer runs (entry reconcile, drift auto-sync, or the
  // manual run): the Sync button becomes the progress indicator. Nothing else
  // freezes — roster writes rebase onto a concurrent sync commit.
  syncing: boolean
  // Omitted when this viewer must not write roster.csv: a non-owner whose
  // roster is partly read from the CSV itself (useTeamRoster.rosterSource ===
  // "csv") has no full team picture to sync from, so the button is hidden.
  onSync?: () => void
  // When roster.csv last changed (its latest commit) — null while unknown.
  // Rendered as an "Updated x ago" caption beside the Refresh button.
  lastUpdatedAt?: Date | null
  // Outcome of the most recent completed refresh this session: null before
  // any run, 0 for "no changes", otherwise the number of rows it touched.
  lastSyncChanges?: number | null
  selectedRows: TeamRosterRow[]
  onClearSelection: () => void
  onBulkDone: (
    action: "unenroll" | "invite" | "cancel" | "removeRows",
    removed?: Array<Pick<TeamRosterRow, "username">>,
  ) => void
  query: string
  onQueryChange: (query: string) => void
  onClearAllFilters: () => void
  hasActiveFilter: boolean
  hasFilterActive: boolean
  // The combined Show select's value/handler — status filter or `role:x`.
  showValue: string
  onShowChange: (value: string) => void
  statusOptions: { value: string; label: string }[]
  roleFilterOptions: ClassroomRole[]
  canGroupByRole: boolean
  sectionOptions: string[]
  effectiveSection: string
  onSectionChange: (section: string) => void
  grouping: RosterGrouping
  onGroupingChange: (grouping: RosterGrouping) => void
  // null when the viewer can't manage the roster (buttons are simply absent).
  addActions: AddStudentActions | null
  // Enters the batch Edit mode; absent (owner-only) hides the button.
  onEditRoster?: () => void
}) {
  const { t } = useTranslation()
  // "Updated x ago · no changes" — the last-commit timestamp plus, after a
  // refresh has run this session, whether it actually changed anything.
  const captionParts: string[] = []
  if (lastUpdatedAt) {
    captionParts.push(
      t("students.rosterUpdatedAgo", {
        when: formatRelativeToNow(lastUpdatedAt),
      }),
    )
  }
  if (lastSyncChanges !== null) {
    captionParts.push(
      lastSyncChanges === 0
        ? t("students.syncResultNoChanges")
        : t("students.syncResultChanges", { count: lastSyncChanges }),
    )
  }
  return (
    <Toolbar>
      {/* The refresh cluster (caption + button + help) yields its spot to the
          selection cluster while rows are selected — one left-side context at
          a time. An active sync only disables the Sync button itself (it is
          the progress indicator; a second pass would just stack). */}
      {selectedRows.length === 0 ? (
        <div className="flex items-center gap-1">
          {!syncing && captionParts.length > 0 ? (
            <span className="hidden text-xs text-base-content/50 md:inline">
              {captionParts.join(" · ")}
            </span>
          ) : null}
          {onSync ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={syncing}
                aria-live="polite"
                className="text-base-content/70"
                onClick={onSync}
                title={
                  syncing
                    ? t("students.syncActiveHelp")
                    : t("students.syncRosterTitle")
                }
              >
                <SyncIcon
                  aria-hidden="true"
                  className={cx("size-4", syncing && "animate-spin")}
                />
                {syncing ? t("students.syncActive") : t("students.syncNow")}
              </Button>
              <HelpTooltip help={t("students.syncHelp")} />
            </>
          ) : null}
        </div>
      ) : null}
      {/* Selection cluster (count + Actions menu + Clear) — appears on the
          left, beside Sync, while rows are selected. Always mounted: it
          renders nothing when idle but owns the bulk-run modals. */}
      <RosterBulkActionsBar
        org={org}
        classroom={classroom}
        client={client}
        selectedRows={selectedRows}
        onClearSelection={onClearSelection}
        onDone={onBulkDone}
      />
      <Toolbar.Trailing>
        <Toolbar.Search
          placeholder={t("students.searchPlaceholder")}
          ariaLabel={t("students.searchLabel")}
          value={query}
          onChange={onQueryChange}
          onClear={onClearAllFilters}
          clearActive={hasActiveFilter}
          hasFilterActive={hasFilterActive}
        />
        {/* One combined "Show" select: enrollment states, then a role group
            (only when staff exist). Sorting lives in the column headers, so
            the toolbar carries filters and view options only. */}
        <Toolbar.FilterSelect
          icon={<FilterIcon aria-hidden="true" className="size-4" />}
          active={showValue !== "all"}
          aria-label={t("students.filterShowLabel")}
          value={showValue}
          onChange={(e) => onShowChange(e.target.value)}
        >
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {canGroupByRole ? (
            <>
              <SelectSeparatorOption />
              {roleFilterOptions.map((role) => (
                <option key={role} value={`role:${role}`}>
                  {t(ROLE_LABEL_KEY[role])}
                </option>
              ))}
            </>
          ) : null}
        </Toolbar.FilterSelect>
        {sectionOptions.length > 0 ? (
          <Toolbar.FilterSelect
            icon={<FilterIcon aria-hidden="true" className="size-4" />}
            active={effectiveSection !== "all"}
            className="max-w-[10rem]"
            aria-label={t("students.filterBySectionLabel")}
            value={effectiveSection}
            onChange={(e) => onSectionChange(e.target.value)}
          >
            <option value="all">{t("students.filterAllSections")}</option>
            {sectionOptions.map((section) => (
              <option key={section} value={section}>
                {section === NO_SECTION ? t("students.noSection") : section}
              </option>
            ))}
          </Toolbar.FilterSelect>
        ) : null}
        {/* Grouping is a view option, offering exactly the two groupable
            columns — Role and Section — each only when the roster actually
            has that dimension. */}
        {canGroupByRole || sectionOptions.length > 0 ? (
          <Toolbar.FilterSelect
            icon={<RowsIcon aria-hidden="true" className="size-4" />}
            active={grouping !== "none"}
            aria-label={t("students.groupBy.label")}
            value={grouping}
            onChange={(e) => onGroupingChange(e.target.value as RosterGrouping)}
          >
            <option value="none">{t("students.groupBy.none")}</option>
            {canGroupByRole ? (
              <option value="role">{t("students.groupBy.role")}</option>
            ) : null}
            {sectionOptions.length > 0 ? (
              <option value="section">{t("students.groupBy.section")}</option>
            ) : null}
          </Toolbar.FilterSelect>
        ) : null}
        {/* The add-students actions: prominent text buttons on the toolbar's
            right edge (see AddStudentButtons — shared with the empty state so
            labels can't drift). Kept in place while rows are selected (the
            selection cluster lives on the left) and usable during a sync. */}
        {addActions ? (
          <AddStudentButtons
            addActions={addActions}
            onEditRoster={onEditRoster}
          />
        ) : null}
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default RosterToolbar
