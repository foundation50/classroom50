import { useTranslation } from "react-i18next"

import { FilterIcon, RowsIcon, SyncIcon } from "@/components/ui/icons"
import { Button, SelectSeparatorOption, Toolbar, cx } from "@/components/ui"
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
}: {
  org: string
  classroom: string
  client: GitHubClient
  // True while any sync writer runs (entry reconcile, drift auto-sync, or the
  // manual run): the Sync button becomes the progress indicator and every
  // roster-writing control in the toolbar freezes.
  syncing: boolean
  onSync: () => void
  selectedRows: TeamRosterRow[]
  onClearSelection: () => void
  onBulkDone: (
    action: "unenroll" | "invite" | "cancel",
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
}) {
  const { t } = useTranslation()
  return (
    <Toolbar>
      <Button
        variant="ghost"
        size="sm"
        disabled={syncing}
        aria-live="polite"
        className="text-base-content/70"
        onClick={onSync}
        title={
          syncing ? t("students.syncActiveHelp") : t("students.syncRosterTitle")
        }
      >
        <SyncIcon
          aria-hidden="true"
          className={cx("size-4", syncing && "animate-spin")}
        />
        {syncing ? t("students.syncActive") : t("students.syncNow")}
      </Button>
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
        disabled={syncing}
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
            selection cluster lives on the left); disabled while a sync
            rewrites the roster. */}
        {addActions ? (
          <AddStudentButtons addActions={addActions} disabled={syncing} />
        ) : null}
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default RosterToolbar
