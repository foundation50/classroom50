import { useTranslation } from "react-i18next"
import { Download, FileText, Search, X } from "lucide-react"

import { Button, Input, LabeledControl, Select } from "@/components/ui"
import type { TimelineSource, TimelineType } from "@/lib/activity/timeline"

export type ActivityFilterState = {
  // Empty set = "all". The dropdowns are single-select, so each set holds 0 or 1
  // value; the Set shape is kept because mergeTimeline filters on membership.
  sources: Set<TimelineSource>
  types: Set<TimelineType>
}

const SOURCE_ORDER: TimelineSource[] = ["commit", "run", "session"]
const TYPE_ORDER: TimelineType[] = [
  "assignment",
  "classroom",
  "student",
  "scores",
  "config",
  "run",
  "error",
  "action",
]

// A labeled single-select in the shared toolbar prefix style ("Source: All").
const LabeledSelect = ({
  label,
  children,
  ...props
}: {
  label: string
} & React.ComponentPropsWithoutRef<"select">) => (
  <LabeledControl label={label}>
    <Select selectSize="sm" className="join-item w-auto min-w-0" {...props}>
      {children}
    </Select>
  </LabeledControl>
)

// Read/write a single-select value backed by a Set: "" = all (empty set), else a
// one-element set.
function selectValue<T extends string>(set: Set<T>): T | "" {
  const [first] = set
  return (first ?? "") as T | ""
}
function toSet<T extends string>(value: string): Set<T> {
  return value ? new Set([value as T]) : new Set<T>()
}

// The unified Activity toolbar: one wrapping bar with search + Source/Type
// filters on the left and the Export CSV / Show diagnostics actions pushed right
// — the same shape as the org home and submissions toolbars.
export function ActivityToolbar({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  onExportCsv,
  onShowDiagnostics,
  resultCount,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: ActivityFilterState
  onFiltersChange: (next: ActivityFilterState) => void
  onExportCsv: () => void
  onShowDiagnostics: () => void
  resultCount: number
}) {
  const { t } = useTranslation()

  const hasActiveFilter =
    query.trim() !== "" || filters.sources.size > 0 || filters.types.size > 0

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ sources: new Set(), types: new Set() })
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <Input
        type="search"
        inputSize="sm"
        className="min-w-[12rem] flex-1 sm:max-w-xs"
        leadingIcon={
          <Search aria-hidden="true" className="size-4 opacity-60" />
        }
        placeholder={t("orgActivity.searchPlaceholder")}
        aria-label={t("orgActivity.searchLabel")}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />

      <LabeledSelect
        label={t("orgActivity.filters.source")}
        value={selectValue(filters.sources)}
        aria-label={t("orgActivity.filters.source")}
        onChange={(e) =>
          onFiltersChange({ ...filters, sources: toSet(e.target.value) })
        }
      >
        <option value="">{t("orgActivity.filters.allSources")}</option>
        {SOURCE_ORDER.map((s) => (
          <option key={s} value={s}>
            {t(`orgActivity.source.${s}`)}
          </option>
        ))}
      </LabeledSelect>

      <LabeledSelect
        label={t("orgActivity.filters.type")}
        value={selectValue(filters.types)}
        aria-label={t("orgActivity.filters.type")}
        onChange={(e) =>
          onFiltersChange({ ...filters, types: toSet(e.target.value) })
        }
      >
        <option value="">{t("orgActivity.filters.allTypes")}</option>
        {TYPE_ORDER.map((ty) => (
          <option key={ty} value={ty}>
            {t(`orgActivity.type.${ty}`)}
          </option>
        ))}
      </LabeledSelect>

      {hasActiveFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X aria-hidden="true" className="size-4" />
          {t("orgActivity.clearFilters")}
        </Button>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={resultCount === 0}
          onClick={onExportCsv}
        >
          <Download aria-hidden="true" className="size-4" />
          {t("orgActivity.exportCsv")}
        </Button>
        <Button variant="outline" size="sm" onClick={onShowDiagnostics}>
          <FileText aria-hidden="true" className="size-4" />
          {t("orgActivity.showDiagnostics")}
        </Button>
      </div>
    </div>
  )
}
