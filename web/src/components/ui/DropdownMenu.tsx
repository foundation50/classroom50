import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"

import { Link, type LinkComponentProps } from "@tanstack/react-router"

import { useDismissOnEscape } from "@/hooks/useDismissOnEscape"
import { useDismissOnOutsidePointerDown } from "@/hooks/useDismissOnOutsidePointerDown"
import type { OverlayAlign } from "./anchoredPopover"
import { Button, type ButtonProps } from "./Button"
import { cx } from "./cx"
import { CheckIcon } from "./icons"
import { Popover } from "./Popover"

// The app's dropdown menu, following the WAI-ARIA menu button pattern:
//
//   <Dropdown align="end">
//     <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
//     <DropdownMenu>
//       <DropdownMenu.Item label="..." onSelect={...} />
//     </DropdownMenu>
//   </Dropdown>
//
// It replaces daisyUI's focus-driven `dropdown` recipe, whose menu was
// absolutely positioned inside the trigger's box and so got clipped by any
// `overflow` ancestor (a modal box, a table frame, the sidebar rail) or covered
// by a z-indexed sibling, the same class of bug as issue #1026 for tooltips.
// The menu is a top-layer popover positioned against the Dropdown root (the
// whole wrapper, like daisyUI: a trigger joined to an input anchors the row).
//
// Open state is explicit React state. Click or Enter/Space toggles; ArrowDown
// opens with the first item focused, ArrowUp with the last; arrows/Home/End
// rove; Escape closes and returns focus to the trigger; Tab or an outside
// pointer-down closes. Menu items stay ordinary buttons/links (daisyUI `menu`
// styling), so tests and assistive tech address them by their labels. Rows
// that Item / LinkItem / RouterLinkItem don't cover call `useDropdown().close`.

type FocusEdge = "first" | "last"

type DropdownContextValue = {
  open: boolean
  align: OverlayAlign
  matchTriggerWidth: boolean
  menuId: string
  rootRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | HTMLAnchorElement | null>
  menuRef: RefObject<HTMLElement | null>
  toggle: () => void
  // Opening from the keyboard lands focus on the first or last item.
  openFocusing: (edge: FocusEdge) => void
  close: (options?: { returnFocus?: boolean }) => void
  pendingFocusRef: RefObject<FocusEdge | null>
}

const DropdownContext = createContext<DropdownContextValue | null>(null)

function useDropdownContext(component: string): DropdownContextValue {
  const context = useContext(DropdownContext)
  if (!context) {
    throw new Error(`${component} must be rendered inside <Dropdown>`)
  }
  return context
}

// For rows rendered by a component of their own inside a <DropdownMenu> that
// aren't a stock Item (a row with a spinner, a custom check mark): close the
// menu directly instead of bridging through a DOM event.
export function useDropdown(): {
  open: boolean
  close: (options?: { returnFocus?: boolean }) => void
} {
  const { open, close } = useDropdownContext("useDropdown")
  return { open, close }
}

const MENU_ITEM_SELECTOR =
  'button:not(:disabled), a[href], [role="menuitem"]:not([aria-disabled="true"])'

// The focusable rows of one menu, excluding anything inside a nested popover.
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu
    ? Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
        (item) => item.closest("[popover]") === menu,
      )
    : []
}

function focusEdge(menu: HTMLElement | null, edge: FocusEdge) {
  const items = menuItems(menu)
  ;(edge === "last" ? items[items.length - 1] : items[0])?.focus()
}

export type DropdownProps = {
  // Which edge of the root the menu lines up with (daisyUI dropdown-start /
  // dropdown-end). Inline-relative: flips under RTL.
  align?: OverlayAlign
  // Size the menu to the root's width (a version picker under its input).
  matchTriggerWidth?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
} & Omit<ComponentPropsWithoutRef<"div">, "children">

export function Dropdown({
  align = "start",
  matchTriggerWidth = false,
  onOpenChange,
  className,
  children,
  ...props
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  // Mirrors `open` so a transition can be decided (and reported) outside the
  // state updater, which React requires to be pure and double-runs in
  // StrictMode; notifying from inside it would set a parent's state mid-render.
  const openRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null)
  const menuRef = useRef<HTMLElement | null>(null)
  const pendingFocusRef = useRef<FocusEdge | null>(null)
  const menuId = useId()

  const setOpenNotify = useCallback(
    (next: boolean) => {
      if (openRef.current === next) return
      openRef.current = next
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  const close = useCallback(
    ({ returnFocus = false } = {}) => {
      setOpenNotify(false)
      if (returnFocus) triggerRef.current?.focus()
    },
    [setOpenNotify],
  )

  useDismissOnOutsidePointerDown(rootRef, open, close)

  const closeReturningFocus = useCallback(
    () => close({ returnFocus: true }),
    [close],
  )
  useDismissOnEscape(rootRef, open, closeReturningFocus)

  const value = useMemo<DropdownContextValue>(
    () => ({
      open,
      align,
      matchTriggerWidth,
      menuId,
      rootRef,
      triggerRef,
      menuRef,
      pendingFocusRef,
      toggle: () => {
        pendingFocusRef.current = open ? null : "first"
        setOpenNotify(!open)
      },
      openFocusing: (edge) => {
        if (open) {
          focusEdge(menuRef.current, edge)
          return
        }
        pendingFocusRef.current = edge
        setOpenNotify(true)
      },
      close,
    }),
    [open, align, matchTriggerWidth, menuId, setOpenNotify, close],
  )

  // Focus leaving the whole widget (Tab out of the last item, or into another
  // control) closes, matching native menus. A native listener on the root
  // rather than a JSX handler: a div with keyboard/focus handlers reads as a
  // fake interactive element to the a11y lint.
  useEffect(() => {
    const root = rootRef.current
    if (!open || !root) return
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (!(next instanceof Node && root.contains(next))) close()
    }
    root.addEventListener("focusout", onFocusOut)
    return () => root.removeEventListener("focusout", onFocusOut)
  }, [open, close])

  return (
    <DropdownContext.Provider value={value}>
      <div
        ref={rootRef}
        data-dropdown=""
        className={cx("inline-block", className)}
        {...props}
      >
        {children}
      </div>
    </DropdownContext.Provider>
  )
}

export type DropdownMenuProps = HTMLAttributes<HTMLElement>

export function DropdownMenu({
  className,
  children,
  onKeyDown,
  ...props
}: DropdownMenuProps) {
  const {
    open,
    align,
    matchTriggerWidth,
    menuId,
    rootRef,
    menuRef,
    close,
    pendingFocusRef,
  } = useDropdownContext("DropdownMenu")

  // Land focus on the requested item once the popover is shown (a hidden
  // popover cannot take focus, so this has to follow the positioning effect).
  useEffect(() => {
    if (!open || !pendingFocusRef.current) return
    focusEdge(menuRef.current, pendingFocusRef.current)
    pendingFocusRef.current = null
  }, [open, pendingFocusRef, menuRef])

  const rove = (event: KeyboardEvent<HTMLElement>) => {
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    let next: number
    switch (event.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : (current + 1) % items.length
        break
      case "ArrowUp":
        next = current <= 0 ? items.length - 1 : current - 1
        break
      case "Home":
        next = 0
        break
      case "End":
        next = items.length - 1
        break
      case "Tab":
        // APG menu button: Tab closes the menu and moves on. Refocusing the
        // trigger first (without preventDefault) makes the browser's own Tab
        // continue from there, past the now-hidden menu, in either direction.
        close({ returnFocus: true })
        return
      default:
        return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <Popover
      as="ul"
      ref={menuRef}
      id={menuId}
      role="menu"
      // WebKit does not focus a plain <button> on mousedown and clears focus
      // when no focusable ancestor exists, which would fire the root focusout
      // and close the menu before the item's click lands (#987). A
      // mouse-focusable, non-tabbable menu keeps focus inside the root.
      tabIndex={-1}
      open={open}
      anchorRef={rootRef}
      align={align}
      matchAnchorWidth={matchTriggerWidth}
      keepMounted
      className={cx("menu p-1", className)}
      onKeyDown={(event) => {
        rove(event)
        onKeyDown?.(event)
      }}
      {...props}
    >
      {children}
    </Popover>
  )
}

// The one separator recipe for menu groups, so the divider chrome can't drift
// per caller. An empty <li> is valid inside the menu list and is daisyUI's own
// divider hook: `.menu :where(li:empty)` draws the 1px inset rule, so no
// border or margin classes here (they would fight that recipe). daisyUI's
// `.divider` is a flex helper with its own min-height and heavy color that
// renders as a stray dark bar inside a compact `.menu`.
export function MenuSeparator() {
  return <li role="separator" className="pointer-events-none" />
}
DropdownMenu.Separator = MenuSeparator

export type DropdownTriggerProps = Omit<ButtonProps, "tabIndex">

// The one trigger recipe: wires the menu-button ARIA and keyboard contract.
// tabIndex is applied after the spread so a spread-in value cannot displace it
// (Safari only focuses a button on click when it is explicit, #987).
function DropdownTrigger({
  onClick,
  onKeyDown,
  ...props
}: DropdownTriggerProps) {
  const { open, menuId, triggerRef, toggle, openFocusing } = useDropdownContext(
    "DropdownMenu.Trigger",
  )
  return (
    <Button
      {...props}
      ref={triggerRef}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      onClick={(event) => {
        toggle()
        onClick?.(event)
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          openFocusing(event.key === "ArrowDown" ? "first" : "last")
        }
        onKeyDown?.(event)
      }}
      tabIndex={0}
    />
  )
}
DropdownMenu.Trigger = DropdownTrigger

type MenuIcon = ComponentType<{
  className?: string
  "aria-hidden"?: boolean | "true" | "false"
}>

export type DropdownMenuItemProps = {
  icon?: MenuIcon
  // Extra classes on the icon (an `animate-spin` while the action runs).
  iconClassName?: string
  label: ReactNode
  // Native disabled plus a guard in onClick: daisyUI's menu items are plain
  // buttons, and a disabled one still needs its title to explain why.
  disabled?: boolean
  title?: string
  destructive?: boolean
  // For pick-one menus (a version list): the chosen row is emphasized and
  // carries a check mark in the icon slot; its siblings reserve the slot so
  // labels line up.
  selected?: boolean
  onSelect: () => void
}

// The one menu-item recipe: closes the menu, then acts. Destructive items are
// red text (the confirm dialog carries the danger tone).
function DropdownMenuItem({
  icon: Icon,
  iconClassName,
  label,
  disabled = false,
  title,
  destructive = false,
  selected,
  onSelect,
}: DropdownMenuItemProps) {
  const { close } = useDropdownContext("DropdownMenu.Item")
  return (
    <li>
      <button
        type="button"
        className={cx(
          destructive && "text-error",
          selected && "active font-semibold",
        )}
        disabled={disabled}
        title={title}
        onClick={() => {
          close({ returnFocus: true })
          if (disabled) return
          onSelect()
        }}
      >
        {selected !== undefined ? (
          <CheckIcon
            aria-hidden="true"
            className={cx("size-4", !selected && "invisible")}
          />
        ) : Icon ? (
          <Icon aria-hidden="true" className={cx("size-4", iconClassName)} />
        ) : null}
        {label}
      </button>
    </li>
  )
}
DropdownMenu.Item = DropdownMenuItem

export type DropdownMenuLinkItemProps = {
  icon?: MenuIcon
  label: ReactNode
  href: string
  title?: string
}

// A menu item that opens an off-site page in a new tab (a run on GitHub). The
// same row chrome as Item; the menu closes as the new tab opens.
function DropdownMenuLinkItem({
  icon: Icon,
  label,
  href,
  title,
}: DropdownMenuLinkItemProps) {
  const { close } = useDropdownContext("DropdownMenu.LinkItem")
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        onClick={() => close({ returnFocus: true })}
      >
        {Icon ? <Icon aria-hidden="true" className="size-4" /> : null}
        {label}
      </a>
    </li>
  )
}
DropdownMenu.LinkItem = DropdownMenuLinkItem

export type DropdownMenuRouterLinkItemProps = {
  icon?: MenuIcon
  label: ReactNode
} & Omit<LinkComponentProps<"a">, "children" | "onClick">

// A menu item that navigates in-app (Edit, Manage token). The same row chrome
// as Item; the menu closes as the navigation starts.
function DropdownMenuRouterLinkItem({
  icon: Icon,
  label,
  ...linkProps
}: DropdownMenuRouterLinkItemProps) {
  const { close } = useDropdownContext("DropdownMenu.RouterLinkItem")
  return (
    <li>
      <Link {...linkProps} onClick={() => close({ returnFocus: true })}>
        {Icon ? <Icon aria-hidden="true" className="size-4" /> : null}
        {label}
      </Link>
    </li>
  )
}
DropdownMenu.RouterLinkItem = DropdownMenuRouterLinkItem

export default DropdownMenu
