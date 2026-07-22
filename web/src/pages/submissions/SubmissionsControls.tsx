import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Share2 } from "lucide-react"

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
// widget (freshness line + Sync/Refresh button); a standalone Share button sits
// by the search bar; `trailing` hosts the Actions menu (Metrics, Collect,
// Regrade, CSV) — so freshness, search + filters, and actions share one bar,
// keeping the roster high on the page.
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
  hideSortAndStatus = false,
  onShare,
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
  // When live data is shown the view is a fixed name-ordered, unfiltered
  // presence view (the page-scoped fan-out can only align to that), so Sort and
  // the Status/Passing selects are HIDDEN — not just disabled — to keep the
  // toolbar honest. Search + Section still apply (they don't reorder the spine).
  hideSortAndStatus?: boolean
  // Opens the Share (accept-link) modal. Rendered as a prominent button next to
  // the search bar (the most common non-grading action), not buried in Actions.
  onShare?: () => void
  // Left-aligned lead content (the DataFreshness widget). Search + filters +
  // sort + actions sit on the right.
  leading?: ReactNode
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  // In live mode only search + section apply, so the Clear affordance must
  // ignore the latent status/passing values (hidden, not user-editable here).
  const hasActiveFilter = hideSortAndStatus
    ? filters.section !== "all" || query.trim() !== ""
    : filters.submission !== "all" ||
      filters.passing !== "all" ||
      filters.accepted !== "all" ||
      filters.section !== "all" ||
      query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    // Preserve the hidden status/passing/accepted axes in live mode; clear only
    // what's exposed (search + section).
    onFiltersChange(
      hideSortAndStatus
        ? { ...filters, section: "all" }
        : { ...DEFAULT_FILTERS },
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

        {onShare && (
          <Button variant="outline" size="sm" onClick={onShare}>
            <Share2 aria-hidden="true" className="size-4" />
            {t("submissions.menu.share")}
          </Button>
        )}

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

        {!hideSortAndStatus && (
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

        {!hideSortAndStatus && passingAvailable && (
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

        {!hideSortAndStatus && (
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
