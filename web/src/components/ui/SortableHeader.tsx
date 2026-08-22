import type { ReactNode } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

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
        <ArrowUp aria-hidden="true" className="size-3.5" />
      ) : direction === "desc" ? (
        <ArrowDown aria-hidden="true" className="size-3.5" />
      ) : (
        <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-40" />
      )}
    </button>
  )
}

export default SortableHeader
