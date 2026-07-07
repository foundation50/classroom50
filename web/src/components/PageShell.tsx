import type { ReactNode } from "react"

import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"

const DEFAULT_CONTENT_CLASS = "p-10 bg-base-200 2xl:px-50"

// Every drawer page repeated the Drawer/toggle/content/sidebar structure;
// PageShell owns it so pages render only their content.
//
// contentClassName overrides the DrawerContent padding — the default matches the
// 10 pages on `2xl:px-50`; the three `xl:px-50` owner pages pass their variant.
// The DrawerSidebar props (page/selected/settings) are threaded through
// unchanged; PR 4 will replace them with route-derived active-state.
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
        <DrawerContent className={contentClassName}>{children}</DrawerContent>
        <DrawerSidebar page={page} selected={selected} settings={settings} />
      </Drawer>
    </div>
  )
}
