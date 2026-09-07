import type { ComponentPropsWithRef } from "react"

import { cx } from "./cx"

// Single source for the DaisyUI dropdown menu surface so the popover chrome
// can't drift. Callers own the `dropdown` wrapper and trigger; pass sizing
// utilities (width, max-height, overflow) via className.
export type DropdownMenuProps = ComponentPropsWithRef<"ul">

// The one popover-surface recipe (chrome only, no layout), shared by
// DropdownMenu, Combobox, and panel-style popovers that aren't a bare menu.
export const popoverPanelClass =
  "z-10 mt-1 rounded-box border border-base-300 bg-base-100 shadow"

export function DropdownMenu({
  className,
  children,
  ...props
}: DropdownMenuProps) {
  return (
    <ul
      tabIndex={0}
      role="menu"
      className={cx("dropdown-content menu p-1", popoverPanelClass, className)}
      {...props}
    >
      {children}
    </ul>
  )
}

// The one separator recipe for menu groups, so the divider chrome can't drift
// per caller.
function DropdownMenuSeparator() {
  return (
    <div className="my-1 border-t border-base-content/10" role="separator" />
  )
}
DropdownMenu.Separator = DropdownMenuSeparator

// daisyUI dropdowns are focus-driven, so "close the menu" is "blur the focused
// item". The single helper for every menu item's onClick.
export function closeDropdownMenu(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

export default DropdownMenu
