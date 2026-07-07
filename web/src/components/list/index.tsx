// Shared list-page chrome reused by the org homepage and the My Classrooms
// list. Labels are passed in (already run through t()) so each page keeps its
// own i18n namespace while sharing the markup and behavior.

import { LayoutGrid, List as ListIcon } from "lucide-react"

export type ListViewMode = "grid" | "list"

export function ViewToggle({
  viewMode,
  onChange,
  groupLabel,
  gridLabel,
  listLabel,
}: {
  viewMode: ListViewMode
  onChange: (mode: ListViewMode) => void
  groupLabel: string
  gridLabel: string
  listLabel: string
}) {
  return (
    <div role="group" aria-label={groupLabel} className="join">
      <button
        type="button"
        className={`btn btn-sm join-item ${viewMode === "grid" ? "btn-active" : ""}`}
        aria-label={gridLabel}
        aria-pressed={viewMode === "grid"}
        onClick={() => onChange("grid")}
      >
        <LayoutGrid aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        className={`btn btn-sm join-item ${viewMode === "list" ? "btn-active" : ""}`}
        aria-label={listLabel}
        aria-pressed={viewMode === "list"}
        onClick={() => onChange("list")}
      >
        <ListIcon aria-hidden="true" className="size-4" />
      </button>
    </div>
  )
}

export function NoSearchResults({
  title,
  body,
  clearLabel,
  onClear,
}: {
  title: string
  body: string
  clearLabel: string
  onClear: () => void
}) {
  return (
    <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-base-content/70">
        {body}
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-sm mt-4"
        onClick={onClear}
      >
        {clearLabel}
      </button>
    </div>
  )
}
