import type { ReactNode } from "react"

import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"

const DEFAULT_CONTENT_CLASS = "p-6 bg-base-200 2xl:px-8"

// Every drawer page repeated the Drawer/toggle/content/sidebar structure;
// PageShell owns it so pages render only their content.
//
// contentClassName overrides the DrawerContent padding — the default (a tight
// p-6 frame with only a modest 2xl gutter) now covers every page, including the
// former owner-page variants. The DrawerSidebar props (page/selected/settings)
// are threaded through unchanged; PR 4 will replace them with route-derived
// active-state.
export default function PageShell({
  children,
  contentClassName = DEFAULT_CONTENT_CLASS,
  page,
  selected,
  settings,
}: {
  children: ReactNode
  contentClassName?: string
  page?: string
  selected?: string
  settings?: boolean
}) {
  return (
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className={contentClassName}>
          {/* One vertical rhythm for every page: sections are direct children
              spaced by gap-6, so pages don't hand-roll per-block margins (the
              org homepage's look, now the default). */}
          <div className="flex flex-col gap-6">{children}</div>
        </DrawerContent>
        <DrawerSidebar page={page} selected={selected} settings={settings} />
      </Drawer>
    </div>
  )
}
