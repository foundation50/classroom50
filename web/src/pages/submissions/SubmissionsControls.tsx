import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Button, Toolbar } from "@/components/ui"
import type {
  StatusSelectValue,
  SubmissionFilters,
  SubmissionSort,
} from "@/pages/submissions/dashboard"
import {
  DEFAULT_FILTERS,
  applyStatusSelection,
  statusSelectValue,
} from "@/pages/submissions/dashboard"

// Search + sort + filter controls for the assignment overview dashboard.
// Controlled by SubmissionsPage; emits filter/sort/query changes. The
// not-submitted filter is hidden for group assignments; passing/accepted selects
// appear only when available. `trailing` hosts the page's toolbar actions
// (updated/refresh, Metrics, Invite, Actions menu) so they share one bar with
// search + filters — keeping the roster high on the page.
const SubmissionsControls = ({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  isGroup = false,
  acceptedAvailable = false,
  passingAvailable = false,
  sections = [],
  liveCapable = false,
  viewMode = "static",
  onViewModeChange,
  trailing,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: SubmissionFilters
  onFiltersChange: (filters: SubmissionFilters) => void
  sort: SubmissionSort
  onSortChange: (sort: SubmissionSort) => void
  isGroup?: boolean
  acceptedAvailable?: boolean
  passingAvailable?: boolean
  sections?: string[]
  // Whether a live view is possible (org owner, autograded assignment). When
  // false the Live/Static toggle is hidden — the viewer only has the static
  // snapshot.
  liveCapable?: boolean
  // The active view. In "live" the Sort and Status/Passing controls are disabled
  // (live is a fixed name-ordered, unfiltered presence view); "static" unlocks
  // them over the collected snapshot.
  viewMode?: "live" | "static"
  onViewModeChange?: (mode: "live" | "static") => void
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  // Live mode is a fixed name-ordered, unfiltered view (the page-scoped fan-out
  // can only align to that), so sort + status/passing filtering are disabled and
  // point the teacher at Static view.
  const liveLocked = liveCapable && viewMode === "live"
  const lockedHint = liveLocked ? t("submissions.view.lockedHint") : undefined
  const hasActiveFilter =
    filters.submission !== "all" ||
    filters.passing !== "all" ||
    filters.accepted !== "all" ||
    filters.section !== "all" ||
    query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ ...DEFAULT_FILTERS })
  }

  // The Status select folds the submission axis and the acceptance axis into one
  // control. Underneath they stay separate fields on SubmissionFilters (the
  // dashboard filter logic is unchanged); the select is just a combined view.
  // The value↔filters mapping lives in dashboard.ts (statusSelectValue /
  // applyStatusSelection) — typed option ids, unit-tested, no string parsing.
  const statusValue = statusSelectValue(filters)
  const onStatusChange = (value: StatusSelectValue) =>
    onFiltersChange(applyStatusSelection(filters, value))

  return (
    <Toolbar>
      {liveCapable && onViewModeChange && (
        <div
          className="join"
          role="group"
          aria-label={t("submissions.view.toggleAria")}
        >
          <button
            type="button"
            className={`btn btn-sm join-item ${viewMode === "live" ? "btn-active btn-primary" : "btn-ghost"}`}
            aria-pressed={viewMode === "live"}
            onClick={() => onViewModeChange("live")}
            title={t("submissions.view.liveHint")}
          >
            {t("submissions.view.live")}
          </button>
          <button
            type="button"
            className={`btn btn-sm join-item ${viewMode === "static" ? "btn-active" : "btn-ghost"}`}
            aria-pressed={viewMode === "static"}
            onClick={() => onViewModeChange("static")}
            title={t("submissions.view.staticHint")}
          >
            {t("submissions.view.static")}
          </button>
        </div>
      )}
      <Toolbar.Search
        placeholder={
          isGroup
            ? t("submissions.filters.searchGroupPlaceholder")
            : t("submissions.filters.searchStudentPlaceholder")
        }
        value={query}
        onChange={onQueryChange}
        ariaLabel={t("submissions.filters.searchAria")}
      />

      {sections.length > 0 && (
        <Toolbar.FilterSelect
          label={t("submissions.filters.sectionLabel")}
          className="max-w-[10rem]"
          value={filters.section}
          onChange={(e) =>
            onFiltersChange({ ...filters, section: e.target.value })
          }
          aria-label={t("submissions.filters.sectionAria")}
        >
          <option value="all">{t("submissions.filters.allSections")}</option>
          {sections.map((section) => (
            <option key={section} value={section}>
              {section}
            </option>
          ))}
        </Toolbar.FilterSelect>
      )}

      <Toolbar.FilterSelect
        label={t("submissions.filters.submissionLabel")}
        value={statusValue}
        onChange={(e) => onStatusChange(e.target.value as StatusSelectValue)}
        aria-label={t("submissions.filters.submissionAria")}
        disabled={liveLocked}
        title={lockedHint}
      >
        <option value="all">{t("submissions.filters.allStatuses")}</option>
        <option value="submitted">{t("submissions.filters.submitted")}</option>
        <option value="on-time">{t("submissions.filters.onTime")}</option>
        <option value="late">{t("submissions.filters.late")}</option>
        {!isGroup && (
          // A grade requires a submission, so "Not submitted" is mutually
          // exclusive with a passing/failing filter — disable it then.
          <option value="not-submitted" disabled={filters.passing !== "all"}>
            {t("submissions.filters.notSubmitted")}
          </option>
        )}
        {acceptedAvailable && (
          <>
            <option disabled>────────</option>
            <option value="accepted">
              {t("submissions.filters.accepted")}
            </option>
            <option value="not-accepted">
              {t("submissions.filters.notAccepted")}
            </option>
          </>
        )}
      </Toolbar.FilterSelect>

      {passingAvailable && (
        <Toolbar.FilterSelect
          label={t("submissions.filters.passingLabel")}
          value={filters.passing}
          // Disabled when filtering to non-submitters: they have no grade, so a
          // passing/failing filter would always yield an empty table. Also
          // disabled in live mode (which is unfiltered).
          disabled={liveLocked || filters.submission === "not-submitted"}
          title={lockedHint}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              passing: e.target.value as SubmissionFilters["passing"],
            })
          }
          aria-label={t("submissions.filters.passingAria")}
        >
          <option value="all">{t("submissions.filters.allGrades")}</option>
          <option value="passing">{t("submissions.filters.passing")}</option>
          <option value="failing">{t("submissions.filters.failing")}</option>
        </Toolbar.FilterSelect>
      )}

      {hasActiveFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          {t("submissions.filters.clear")}
        </Button>
      )}

      <Toolbar.Trailing>
        <Toolbar.FilterSelect
          label={t("submissions.filters.sortLabel")}
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SubmissionSort)}
          aria-label={t("submissions.filters.sortAria")}
          disabled={liveLocked}
          title={lockedHint}
        >
          <option value="recent">{t("submissions.filters.sortRecent")}</option>
          <option value="oldest">{t("submissions.filters.sortOldest")}</option>
          <option value="name-asc">
            {t("submissions.filters.sortNameAsc")}
          </option>
          <option value="name-desc">
            {t("submissions.filters.sortNameDesc")}
          </option>
        </Toolbar.FilterSelect>
        {trailing}
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default SubmissionsControls
