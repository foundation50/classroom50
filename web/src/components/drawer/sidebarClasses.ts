// Sidebar class-name recipes (dark rail). Single source so a token rename lands once.

export const navItemClass = (active: boolean, collapsed: boolean) =>
  `flex items-center gap-2 rounded-box border-s-2 px-2 py-2 transition-colors ${
    collapsed ? "justify-center" : ""
  } ${
    active
      ? "border-[var(--sidebar-accent)] bg-[var(--sidebar-surface)]"
      : "border-transparent hover:bg-[var(--sidebar-surface)]/60"
  }`

// Shared sidebar tooltip tokens (dark rail): bubble + text colors every
// collapsed-sidebar tooltip uses.
export const sidebarTooltip =
  "tooltip tooltip-right rtl:tooltip-left [--tt-bg:var(--sidebar-surface)] before:text-neutral-content"

// Interactive icon-button row in the rail (back-links, collapse/expand): tooltip
// base plus a muted icon that lightens and gains a surface on hover.
export const sidebarIconButton = (padding: "p-1" | "p-2" = "p-1") =>
  `${sidebarTooltip} cursor-pointer rounded-md ${padding} text-neutral-content/60 transition-colors hover:bg-[var(--sidebar-surface)] hover:text-neutral-content`
