// Sidebar class-name recipes (dark rail). Single source so a token rename lands once.

// Row layout only. The active surface (accent border + filled background) is a
// separate shared-`layoutId` pill (see `sidebarActivePillClass`) that glides
// between rows, so the row keeps just its box + a hover hint for inactive rows.
// `relative` anchors the absolutely-positioned pill; `z` lifts icon/label above it.
export const navItemClass = (active: boolean, collapsed: boolean) =>
  `relative flex items-center gap-2 rounded-box px-2 py-2 ${
    collapsed ? "justify-center" : ""
  } ${
    active
      ? ""
      : "rounded-box transition-colors hover:bg-[var(--sidebar-surface)]/60"
  }`

// The gliding active pill: fills the row with the accent left-border + surface.
// Rendered as an absolutely-positioned sibling behind the row content and shared
// across rows by `layoutId`, so page switches FLIP-tween it into place.
export const sidebarActivePillClass =
  "absolute inset-0 rounded-box border-s-2 border-[var(--sidebar-accent)] bg-[var(--sidebar-surface)]"

// Shared sidebar tooltip tokens (dark rail): bubble + text colors every
// collapsed-sidebar tooltip uses.
export const sidebarTooltip =
  "tooltip tooltip-right rtl:tooltip-left [--tt-bg:var(--sidebar-surface)] before:text-neutral-content"

// Interactive icon-button row in the rail (back-links, collapse/expand): tooltip
// base plus a muted icon that lightens and gains a surface on hover.
export const sidebarIconButton = (padding: "p-1" | "p-2" = "p-1") =>
  `${sidebarTooltip} cursor-pointer rounded-md ${padding} text-neutral-content/60 transition-colors hover:bg-[var(--sidebar-surface)] hover:text-neutral-content`
