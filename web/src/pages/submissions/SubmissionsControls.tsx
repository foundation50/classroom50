import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowSwitchIcon,
  FilterIcon,
  ShareAndroidIcon,
} from "@/components/ui/icons"

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
// just left of the Actions menu; `trailing` hosts the Actions menu (Metrics,
// Collect, Regrade, CSV) — so freshness, search + filters, and actions share one
// bar, keeping the roster high on the page. Sort + Status are always shown, in
// every viewer mode.
const SubmissionsControls = ({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  isGroup = false,
  acceptedAvailable = false,
  acceptanceComplete = true,
  passingAvailable = false,
  sections = [],
  onShare,
  sortHint,
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
  // False for a non-owner, whose repo list holds only what they can read: the
  // "not accepted" option is relabeled to what it really selects for them.
  acceptanceComplete?: boolean
  passingAvailable?: boolean
  sections?: string[]
  // Opens the Share (accept-link) modal. Rendered as a prominent button just
  // left of the Actions menu (the most common non-grading action), not buried in
  // Actions.
  onShare?: () => void
  // Optional affordance rendered right after the Sort select (e.g. a
  // HelpTooltip that explains a sort/filter caveat) — inline in the bar so it
  // doesn't take a full row of its own.
  sortHint?: ReactNode
  // Left-aligned lead content (the DataFreshness widget). Search + filters +
  // sort + actions sit on the right.
  leading?: ReactNode
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  // Distinguish an active filter (section/status/passing/accepted) from a plain
  // search term so the in-search-bar clear affordance can label itself "Clear
  // filter" vs "Clear". Either makes the clear control appear; clicking it
  // resets both (query + filters).
  const hasFilterActive =
    filters.submission !== "all" ||
    filters.passing !== "all" ||
    filters.accepted !== "all" ||
    filters.section !== "all"
  const hasActiveFilter = hasFilterActive || query.trim() !== ""

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
          onClear={clearAll}
          clearActive={hasActiveFilter}
          hasFilterActive={hasFilterActive}
        />

        {sections.length > 0 && (
          <Toolbar.FilterSelect
            icon={<FilterIcon aria-hidden="true" className="size-4" />}
            active={filters.section !== "all"}
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
          icon={<FilterIcon aria-hidden="true" className="size-4" />}
          active={statusValue !== "all"}
          value={statusValue}
          onChange={(e) => onStatusChange(e.target.value as StatusSelectValue)}
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
                {acceptanceComplete
                  ? t("submissions.filters.notAccepted")
                  : t("submissions.filters.repoNotVisible")}
              </option>
            </>
          )}
        </Toolbar.FilterSelect>

        {passingAvailable && (
          <Toolbar.FilterSelect
            icon={<FilterIcon aria-hidden="true" className="size-4" />}
            active={filters.passing !== "all"}
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

        <Toolbar.FilterSelect
          icon={
            <ArrowSwitchIcon aria-hidden="true" className="size-4 rotate-90" />
          }
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SubmissionSort)}
          aria-label={t("submissions.filters.sortAria")}
        >
          <option value="recent">{t("submissions.filters.sortRecent")}</option>
          <option value="oldest">{t("submissions.filters.sortOldest")}</option>
          <option value="name-first">
            {t("submissions.filters.sortNameFirst")}
          </option>
          <option value="name-last">
            {t("submissions.filters.sortNameLast")}
          </option>
        </Toolbar.FilterSelect>

        {sortHint}

        {onShare && (
          <Button variant="outline" size="sm" onClick={onShare}>
            <ShareAndroidIcon aria-hidden="true" className="size-4" />
            {t("submissions.menu.share")}
          </Button>
        )}

        {trailing}
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default SubmissionsControls
