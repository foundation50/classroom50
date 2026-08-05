import { cx } from "./cx"

// A decorative loading-skeleton table cell. `aria-hidden` is on the <td> itself
// (not just the row) for two reasons: it hides the placeholder from assistive
// tech so a screen reader announces the table's busy state instead of rows of
// empty cells, AND jsx-a11y/control-has-associated-label inspects the cell — the
// attribute is what clears that (now blocking) rule for an empty skeleton cell.
//
// `bar` is the skeleton bar's size/position utilities (e.g. "h-4 w-40",
// "ms-auto h-8 w-16"); `tdClassName` is optional layout on the cell itself.

export type SkeletonCellProps = {
  bar: string
  tdClassName?: string
}

export function SkeletonCell({ bar, tdClassName }: SkeletonCellProps) {
  return (
    <td aria-hidden="true" className={tdClassName}>
      <div className={cx("skeleton skeleton-shimmer", bar)} />
    </td>
  )
}

export default SkeletonCell
