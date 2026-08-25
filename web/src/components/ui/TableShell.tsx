import type { ReactNode } from "react"

import { EnterDiv } from "@/lib/motionComponents"
import { SkeletonCell } from "./SkeletonCell"
import { cx } from "./cx"

// The one table frame for the assignment/submission lists: a scrollable
// rounded white box with a visible gray frame and muted header row (GitHub
// Product UI list-box treatment), with the house divider strength (the daisyUI
// default, base-content/5, is nearly invisible — rows blur together).
// Extracted so the teacher/student tables can't hand-sync drift apart.
export type TableShellProps = {
  children: ReactNode
  ariaBusy?: boolean
  // Roomier tbody cell padding — the assignment lists' at-rest row separation.
  padded?: boolean
  // Scale-up entrance; disable when an ancestor already animates the block
  // (nesting two entrances reads as a double pop).
  animate?: boolean
  // Rendered inside the frame before the table (e.g. a bulk-selection bar).
  header?: ReactNode
  // Rendered inside the frame after the table (e.g. a pagination bar).
  footer?: ReactNode
  className?: string
}

export function TableShell({
  children,
  ariaBusy,
  padded = false,
  animate = true,
  header,
  footer,
  className,
}: TableShellProps) {
  const frameClass =
    "overflow-x-auto rounded-box border border-base-300 bg-base-100"
  const table = (
    <table
      className={cx(
        "table [&_tr]:border-base-content/10 [&_thead_tr]:bg-base-200",
        padded && "[&_tbody_td]:py-4",
        className,
      )}
      aria-busy={ariaBusy || undefined}
    >
      {children}
    </table>
  )
  if (!animate) {
    return (
      <div className={frameClass}>
        {header}
        {table}
        {footer}
      </div>
    )
  }
  return (
    <EnterDiv className={frameClass}>
      {header}
      {table}
      {footer}
    </EnterDiv>
  )
}

// Decorative loading placeholder rows — aria-hidden so a screen reader
// announces the table's busy state (aria-busy on the table), not rows of
// empty cells. `bars` is one SkeletonCell width recipe per column.
export function SkeletonRows({
  rows = 4,
  bars,
}: {
  rows?: number
  bars: string[]
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          {bars.map((bar, j) => (
            <SkeletonCell key={j} bar={bar} />
          ))}
        </tr>
      ))}
    </>
  )
}

export default TableShell
