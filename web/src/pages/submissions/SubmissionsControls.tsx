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
// appear only when available. `leading` hosts the left-aligned DataFreshness
// widget (mode toggle + recency + refresh); `trailing` hosts the Actions menu
// (Share, Metrics, Collect, Regrade, CSV) — so freshness, search + filters, and
// actions share one bar, keeping the roster high on the page.
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
  leading,
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
  // Whether a live view is active. In live mode the snapshot-only controls
  // (Sort, Status/Passing) are hidden, since live is a fixed name-ordered,
  // unfiltered view. The Live/Static toggle itself lives in the header's
  // DataFreshness widget, passed here via `leading`.
  liveCapable?: boolean
  viewMode?: "live" | "static"
  // Left-aligned lead content (the DataFreshness widget). Search + filters +
  // sort + actions sit on the right.
  leading?: ReactNode
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  // Live view is a fixed name-ordered, unfiltered presence view (the
  // page-scoped fan-out can only align to that), so the snapshot-only controls
  // (Sort, Status/Passing) are HIDDEN in live mode — not just disabled — to keep
  // the toolbar uncluttered. They return in static view.
  const liveOn = liveCapable && viewMode === "live"
  // In live view only search + section apply (status/passing are hidden and
  // neutralized), so the Clear affordance must ignore the latent status/passing
  // values a prior static session may have left set.
  const hasActiveFilter = liveOn
    ? filters.section !== "all" || query.trim() !== ""
    : filters.submission !== "all" ||
      filters.passing !== "all" ||
      filters.accepted !== "all" ||
      filters.section !== "all" ||
      query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    // Preserve the current status/passing/accepted axes in live mode (they're
    // hidden, not user-editable here); clear only what live exposes.
    onFiltersChange(
      liveOn ? { ...filters, section: "all" } : { ...DEFAULT_FILTERS },
    )
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
      {leading}

      <Toolbar.Trailing>
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

        {!liveOn && (
          <Toolbar.FilterSelect
            label={t("submissions.filters.submissionLabel")}
            value={statusValue}
            onChange={(e) =>
              onStatusChange(e.target.value as StatusSelectValue)
            }
            aria-label={t("submissions.filters.submissionAria")}
          >
            <option value="all">{t("submissions.filters.allStatuses")}</option>
            <option value="submitted">
              {t("submissions.filters.submitted")}
            </option>
            <option value="on-time">{t("submissions.filters.onTime")}</option>
            <option value="late">{t("submissions.filters.late")}</option>
            {!isGroup && (
              // A grade requires a submission, so "Not submitted" is mutually
              // exclusive with a passing/failing filter — disable it then.
              <option
                value="not-submitted"
                disabled={filters.passing !== "all"}
              >
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
        )}

        {!liveOn && passingAvailable && (
          <Toolbar.FilterSelect
            label={t("submissions.filters.passingLabel")}
            value={filters.passing}
            // Disabled when filtering to non-submitters: they have no grade, so
            // a passing/failing filter would always yield an empty table.
            disabled={filters.submission === "not-submitted"}
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

        {!liveOn && (
          <Toolbar.FilterSelect
            label={t("submissions.filters.sortLabel")}
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SubmissionSort)}
            aria-label={t("submissions.filters.sortAria")}
          >
            <option value="recent">
              {t("submissions.filters.sortRecent")}
            </option>
            <option value="oldest">
              {t("submissions.filters.sortOldest")}
            </option>
            <option value="name-asc">
              {t("submissions.filters.sortNameAsc")}
            </option>
            <option value="name-desc">
              {t("submissions.filters.sortNameDesc")}
            </option>
          </Toolbar.FilterSelect>
        )}

        {hasActiveFilter && (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            {t("submissions.filters.clear")}
          </Button>
        )}

        {trailing}
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default SubmissionsControls
