// Sidebar class-name recipes (dark rail). Single source so a token rename lands once.

// Row layout only. The active surface (selected background + accent bar) is a
// separate shared-`layoutId` pill (see `sidebarActivePillClass`) that glides
// between rows, so the row keeps just its box + a hover hint for inactive rows.
// rounded-field is Primer's borderRadius-medium — NavList items are 6px, not
// the 12px box radius.
export const navItemClass = (active: boolean, collapsed: boolean) =>
  `relative flex items-center gap-2 rounded-field px-2 py-2 ${
    collapsed ? "justify-center" : ""
  } ${active ? "" : "transition-colors hover:bg-[var(--sidebar-surface)]/60"}`

// The gliding active pill, styled per Primer's NavList current item: a subtle
// selected surface plus a short 4x24px pill-shaped accent bar vertically
// centered in the start gutter (Primer draws it at inline-start -8px). The bar
// is a `before:` pseudo so it rides along with the FLIP tween. Rendered as an
// absolutely-positioned sibling behind the row content and shared across rows
// by `layoutId`, so page switches FLIP-tween it into place.
export const sidebarActivePillClass =
  "absolute inset-0 rounded-field bg-[var(--sidebar-surface)] before:absolute before:-start-2 before:top-1/2 before:h-6 before:w-1 before:-translate-y-1/2 before:rounded-full before:bg-[var(--sidebar-active-accent)] before:content-['']"

// Bubble colors for every collapsed-rail tooltip: the rail's own surface with
// neutral-content text, so it reads as part of the dark rail. Goes on the
// <Tooltip> host (the bubble inherits the variables).
export const sidebarTooltip =
  "[--tooltip-bg:var(--sidebar-surface)] [--tooltip-fg:var(--color-neutral-content)]"

// Interactive icon-button row in the rail (back-links, collapse/expand): a
// muted icon that lightens and gains a surface on hover. Wrap in a <Tooltip>
// carrying `sidebarTooltip` for the collapsed-rail label.
export const sidebarIconButton = (padding: "p-1" | "p-2" = "p-1") =>
  `inline-flex cursor-pointer rounded-selector ${padding} text-neutral-content/60 transition-colors hover:bg-[var(--sidebar-surface)] hover:text-neutral-content`
