// Shared list-page chrome reused by the org homepage and the My Classrooms
// list. Labels are passed in (already run through t()) so each page keeps its
// own i18n namespace while sharing the markup and behavior.

import { AppsIcon, ListUnorderedIcon } from "@/components/ui/icons"
import type { ComponentType, ReactNode } from "react"

import { Button, Heading, cx } from "@/components/ui"

// Anything icon-shaped: octicons satisfy this, and tests can pass probes.
type EmptyStateIcon = ComponentType<{
  className?: string
  "aria-hidden"?: boolean | "true" | "false"
}>

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
        <AppsIcon aria-hidden="true" className="size-4" />
      </Button>
      <Button
        size="sm"
        active={viewMode === "list"}
        className="join-item"
        aria-label={listLabel}
        aria-pressed={viewMode === "list"}
        onClick={() => onChange("list")}
      >
        <ListUnorderedIcon aria-hidden="true" className="size-4" />
      </Button>
    </div>
  )
}

// Primer Blankslate-style empty state (primer.style/product/ui-patterns/
// empty-states): optional muted icon in a circle, optional title, body,
// one action slot. `variant="card"` is the dashed-border shell for page-level
// blankslates; `variant="bare"` is shell-less for table rows and quiet
// blocks. `className` merges onto the shell (layout-only additions like mt-4).
export function EmptyState({
  icon: Icon,
  title,
  titleAs = "h2",
  body,
  action,
  variant = "card",
  className,
}: {
  icon?: EmptyStateIcon
  title?: ReactNode
  titleAs?: "h1" | "h2" | "h3" | "h4"
  body?: ReactNode
  action?: ReactNode
  variant?: "card" | "bare"
  className?: string
}) {
  return (
    <div
      className={cx(
        "text-center",
        variant === "card"
          ? "rounded-box border border-dashed border-base-300 bg-base-100 p-8"
          : "px-6 py-10",
        className,
      )}
    >
      {Icon && (
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-base-200 text-base-content/70">
          <Icon aria-hidden="true" className="size-6" />
        </div>
      )}
      {title != null && <Heading as={titleAs}>{title}</Heading>}
      {body && (
        <p
          className={cx(
            "mx-auto max-w-md text-sm text-base-content/70",
            title != null && "mt-1",
          )}
        >
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

// Placeholder rows for a list body while its data loads. Shared so list pages
// skeleton-in consistently (content fades into place) instead of a centered
// spinner that content then jumps to replace. Decorative — hidden from
// assistive tech; the surrounding container carries the aria-busy signal.
// Named ListSkeletonRows to keep it distinct from the <tr>-based SkeletonRows
// in components/ui/TableShell.
export function ListSkeletonRows({
  rows = 5,
  className = "divide-y divide-base-200",
}: {
  rows?: number
  className?: string
}) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-6 py-4">
          <div className="skeleton skeleton-shimmer size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="skeleton skeleton-shimmer h-4 w-40" />
            <div className="skeleton skeleton-shimmer h-3 w-24" />
          </div>
          <div className="skeleton skeleton-shimmer h-6 w-20 shrink-0" />
        </div>
      ))}
    </div>
  )
}
