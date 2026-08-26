import type { ComponentPropsWithRef } from "react"

import { cx } from "./cx"

// Single source for the DaisyUI dropdown menu surface so the popover chrome
// can't drift. Callers own the `dropdown` wrapper and trigger; pass sizing
// utilities (width, max-height, overflow) via className.
export type DropdownMenuProps = ComponentPropsWithRef<"ul">

export function DropdownMenu({
  className,
  children,
  ...props
}: DropdownMenuProps) {
  return (
    <ul
      tabIndex={0}
      role="menu"
      className={cx(
        "dropdown-content menu z-10 mt-1 rounded-box border border-base-300 bg-base-100 p-1 shadow",
        className,
      )}
      {...props}
    >
      {children}
    </ul>
  )
}

export default DropdownMenu
