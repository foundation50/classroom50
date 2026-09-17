import {
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"

import {
  useAnchoredPopover,
  type OverlayAlign,
  type OverlaySide,
} from "./anchoredPopover"
import { cx } from "./cx"

// The one popover-surface recipe (chrome only, no layout), shared by
// DropdownMenu, Combobox, and panel-style popovers that aren't a bare menu.
const popoverPanelClass =
  "rounded-box border border-base-300 bg-base-100 text-base-content shadow"

// Offset between an anchor and a menu-style panel (daisyUI's `mt-1`).
const POPOVER_GAP = 4

export type PopoverProps = {
  open: boolean
  // The element the panel hangs off; the panel stays a DOM descendant of the
  // caller's wrapper, so `contains()`-based dismissal and focus tracking work.
  anchorRef: RefObject<HTMLElement | null>
  side?: OverlaySide
  align?: OverlayAlign
  matchAnchorWidth?: boolean
  as?: "div" | "ul"
  // Keep children in the DOM while closed. Menus want this so their items are
  // discoverable without opening (the popover itself is display: none).
  keepMounted?: boolean
  ref?: Ref<HTMLElement | null>
  children: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, "children">

// An anchored panel rendered in the browser's top layer (see anchoredPopover).
// Callers own the open state and dismissal; this positions and shows it.
export function Popover({
  open,
  anchorRef,
  side = "bottom",
  align = "start",
  matchAnchorWidth = false,
  as: Tag = "div",
  keepMounted = false,
  className,
  children,
  ref,
  ...props
}: PopoverProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  useAnchoredPopover({
    open,
    anchorRef,
    panelRef,
    side,
    align,
    gap: POPOVER_GAP,
    matchAnchorWidth,
  })
  const setRef = (node: HTMLElement | null) => {
    panelRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }
  return (
    <Tag
      ref={setRef}
      popover="manual"
      className={cx("overlay-panel", popoverPanelClass, className)}
      {...props}
    >
      {open || keepMounted ? children : null}
    </Tag>
  )
}

export default Popover
