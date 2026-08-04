import { Menu } from "lucide-react"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import { Outlet } from "@tanstack/react-router"
import Drawer, { MOBILE_DRAWER_ID, useSidebarCollapse } from "./collapseContext"
import {
  SidebarContent,
  SidebarContentClasses,
  SidebarContentOrgs,
} from "./SidebarContent"
import { useSidebarNav } from "./useSidebarNav"

// Persistent app shell: the drawer chrome + rail mount ONCE here and page
// content flows through <Outlet/>, so navigating between pages swaps only the
// content while the sidebar (and its motion `layoutId` highlight) stays mounted
// and glides. Rendered by the `_authed` layout route. `topSlot` is app-wide
// chrome (banners) that renders above page content, inside the scroll area.
export const AppShell = ({ topSlot }: { topSlot?: ReactNode }) => (
  <div className="min-h-screen">
    <Drawer>
      <DrawerToggle />
      <DrawerContent>
        {topSlot}
        <Outlet />
      </DrawerContent>
      <DrawerSidebar />
    </Drawer>
  </div>
)

export const DrawerContent = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation()
  return (
    <div className="drawer-content">
      <a
        href="#main-content"
        className="btn btn-primary btn-sm sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50"
      >
        {t("common.skipToMainContent")}
      </a>
      <label
        htmlFor={MOBILE_DRAWER_ID}
        aria-label={t("nav.openMenu")}
        className="btn btn-ghost btn-square fixed top-3 start-3 z-30 lg:hidden"
      >
        <Menu className="size-6" aria-hidden="true" />
      </label>
      <main id="main-content">{children}</main>
    </div>
  )
}

export const DrawerToggle = () => (
  <input id={MOBILE_DRAWER_ID} type="checkbox" className="drawer-toggle" />
)

// The rail lives in the persistent `_authed` shell, so it derives its active
// state from the current route (see useSidebarNav) rather than per-page props —
// this keeps the single motion `layoutId` highlight element mounted across
// navigations so it glides between rows instead of remounting.
export const DrawerSidebar = () => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()
  const { page, selected, settings } = useSidebarNav()
  return (
    <div className="drawer-side z-40">
      <label
        htmlFor={MOBILE_DRAWER_ID}
        aria-label={t("nav.closeMenu")}
        className="drawer-overlay"
      />
      <nav
        aria-label={t("nav.primary")}
        className={`flex flex-col min-h-full bg-neutral text-neutral-content transition-[width] duration-200 ease-out ${
          collapsed
            ? "w-16 min-w-16 [&>div]:px-2"
            : "w-60 min-w-30 [&>div]:px-6"
        }`}
      >
        {page === "classes" ? (
          <SidebarContentClasses selected={selected} settings={settings} />
        ) : page === "orgs" ? (
          <SidebarContentOrgs selected={selected} />
        ) : (
          <SidebarContent selected={selected} />
        )}
      </nav>
    </div>
  )
}
