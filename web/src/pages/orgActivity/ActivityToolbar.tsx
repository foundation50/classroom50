import { useTranslation } from "react-i18next"
import { Check, ClipboardCopy, Download, Search } from "lucide-react"

import { Button, Input } from "@/components/ui"
import { ActivityFilters, type ActivityFilterState } from "./ActivityFilters"

// The Activity page toolbar: a search field + source/type filter chips on the
// left, and the export / copy-diagnostics actions on the right. Mirrors the
// search-and-filter chrome on the Members page; sorting is omitted since the
// timeline is always chronological.
export function ActivityToolbar({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  onExportCsv,
  onCopyDiagnostics,
  copied,
  resultCount,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: ActivityFilterState
  onFiltersChange: (next: ActivityFilterState) => void
  onExportCsv: () => void
  onCopyDiagnostics: () => void
  copied: boolean
  resultCount: number
}) {
  const { t } = useTranslation()

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          inputSize="sm"
          className="min-w-0 flex-1 sm:max-w-xs"
          placeholder={t("orgActivity.searchPlaceholder")}
          aria-label={t("orgActivity.searchLabel")}
          leadingIcon={
            <Search aria-hidden="true" className="size-4 opacity-50" />
          }
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={resultCount === 0}
            onClick={onExportCsv}
          >
            <Download aria-hidden="true" className="size-4" />
            {t("orgActivity.exportCsv")}
          </Button>
          <Button variant="outline" size="sm" onClick={onCopyDiagnostics}>
            {copied ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <ClipboardCopy aria-hidden="true" className="size-4" />
            )}
            {copied
              ? t("orgActivity.copied")
              : t("orgActivity.copyDiagnostics")}
          </Button>
        </div>
      </div>
      <ActivityFilters state={filters} onChange={onFiltersChange} />
    </div>
  )
}
