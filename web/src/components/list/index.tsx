// Shared list-page chrome reused by the org homepage and the My Classrooms
// list. Labels are passed in (already run through t()) so each page keeps its
// own i18n namespace while sharing the markup and behavior.

import { LayoutGrid, List as ListIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui"

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
      <Button
        size="sm"
        active={viewMode === "grid"}
        className="join-item"
        aria-label={gridLabel}
        aria-pressed={viewMode === "grid"}
        onClick={() => onChange("grid")}
      >
        <LayoutGrid aria-hidden="true" className="size-4" />
      </Button>
      <Button
        size="sm"
        active={viewMode === "list"}
        className="join-item"
        aria-label={listLabel}
        aria-pressed={viewMode === "list"}
        onClick={() => onChange("list")}
      >
        <ListIcon aria-hidden="true" className="size-4" />
      </Button>
    </div>
  )
}

// The single dashed-border empty-state card. `className` overrides the default
// shell so the non-uniform call sites keep their own radius/padding (e.g.
// PublishedResourcesPage's rounded-xl/p-6). NoSearchResults and the zero-data
// states across the list pages all render through this.
export function EmptyState({
  icon,
  title,
  body,
  action,
  className = "rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center",
}: {
  icon?: ReactNode
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      {icon}
      <h2 className="text-lg font-semibold">{title}</h2>
      {body && (
        <p className="mx-auto mt-1 max-w-md text-sm text-base-content/70">
          {body}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
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
    <EmptyState
      title={title}
      body={body}
      action={
        <Button variant="ghost" size="sm" onClick={onClear}>
          {clearLabel}
        </Button>
      }
    />
  )
}
