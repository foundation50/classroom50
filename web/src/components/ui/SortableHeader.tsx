import type { ReactNode } from "react"
import {
  ArrowDownIcon,
  ArrowSwitchIcon,
  ArrowUpIcon,
} from "@primer/octicons-react"

// Clickable column-header sort control for tables whose sort state lives in a
// toolbar/page. Renders the header label plus a direction arrow (a faded
// both-ways arrow when this column isn't the active sort). The wrapping <th>
// should carry aria-sort via `ariaSort(direction)` so assistive tech hears the
// active order.
export type SortDirection = "asc" | "desc" | null

export const ariaSort = (
  direction: SortDirection,
): "ascending" | "descending" | undefined =>
  direction === "asc"
    ? "ascending"
    : direction === "desc"
      ? "descending"
      : undefined

export type SortableHeaderProps = {
  label: ReactNode
  direction: SortDirection
  onClick: () => void
  title?: string
}

export function SortableHeader({
  label,
  direction,
  onClick,
  title,
}: SortableHeaderProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex cursor-pointer select-none items-center gap-1 hover:text-base-content"
    >
      {label}
      {direction === "asc" ? (
        <ArrowUpIcon aria-hidden="true" className="size-3.5" />
      ) : direction === "desc" ? (
        <ArrowDownIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <ArrowSwitchIcon
          aria-hidden="true"
          className="size-3.5 opacity-40 rotate-90"
        />
      )}
    </button>
  )
}

// A whole sortable <th>: derives the direction from the active sort vs this
// column's asc/desc values (once — no per-attribute ternaries at call sites),
// carries aria-sort, and toggles asc <-> desc on click (an inactive column
// activates as `initial`, default asc — pass desc for "newest first" time
// columns). Falls back to a static header when `onSortChange` is omitted.
export type SortableThProps<S extends string> = {
  label: ReactNode
  sort: S | undefined
  asc: S
  desc: S
  initial?: S
  onSortChange?: (sort: S) => void
  title?: string
  className?: string
}

export function SortableTh<S extends string>({
  label,
  sort,
  asc,
  desc,
  initial,
  onSortChange,
  title,
  className,
}: SortableThProps<S>) {
  const direction: SortDirection =
    sort === asc ? "asc" : sort === desc ? "desc" : null
  return (
    <th scope="col" className={className} aria-sort={ariaSort(direction)}>
      {onSortChange ? (
        <SortableHeader
          label={label}
          direction={direction}
          onClick={() =>
            onSortChange(
              direction === null
                ? (initial ?? asc)
                : direction === "asc"
                  ? desc
                  : asc,
            )
          }
          title={title}
        />
      ) : (
        label
      )}
    </th>
  )
}

export default SortableHeader
