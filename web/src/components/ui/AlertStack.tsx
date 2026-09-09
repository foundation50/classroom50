import type { HTMLAttributes } from "react"

import { cx } from "./cx"

// A group of page-level notices. Alerts inside one group sit `gap-2` apart
// (the RosterWarnings rhythm); the group itself takes the page's `gap-6`
// section spacing. Without this, each notice tends to become its own section
// and adjacent banners drift apart. A hidden AnimatedAlert renders nothing, so
// a group with nothing to show is `:empty` and collapses out of the page
// rhythm instead of leaving a phantom section gap.
export function AlertStack({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("flex w-full flex-col gap-2 empty:hidden", className)}
      {...rest}
    >
      {children}
    </div>
  )
}

export default AlertStack
