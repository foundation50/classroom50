import { Menu } from "lucide-react"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import { Outlet } from "@tanstack/react-router"
import { AnimatePresence, motion } from "motion/react"
import Drawer, { MOBILE_DRAWER_ID, useSidebarCollapse } from "./collapseContext"
import {
  SidebarContent,
  SidebarContentClasses,
  SidebarContentOrgs,
} from "./SidebarContent"
import { ClassroomLogo, ExpandSidebarButton } from "./primitives"
import { SidebarFooter } from "./SidebarFooter"
import { useSidebarNav } from "./useSidebarNav"
import { sidebarLevelVariants } from "@/lib/motion"

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
    // The base background + full-height live here (not on the per-page frame) so
    // it always covers the viewport even when a page's content is shorter than
    // the window — the page frame (PageShell) only owns padding on top of this.
    <div className="drawer-content min-h-screen bg-base-200">
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
// state from the current route (see useSidebarNav) rather than per-page props.
// Two coordinated animations live here:
//   - The active-row highlight is a single motion `layoutId` pill that stays
//     mounted across navigations and glides between rows (see SidebarItemBody).
//   - The menu BODY swaps on a level change (orgs -> classes -> classroom ->
//     assignment) via one AnimatePresence keyed by `levelKey`. The chrome (logo,
//     expand button, footer) sits OUTSIDE that presence so it stays put while
//     only the menu cross-fades/slides.
export const DrawerSidebar = () => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()
  const { page, selected, settings, levelKey } = useSidebarNav()
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
        <ClassroomLogo />
        <ExpandSidebarButton />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={levelKey}
            variants={sidebarLevelVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {page === "classes" ? (
              <SidebarContentClasses selected={selected} settings={settings} />
            ) : page === "orgs" ? (
              <SidebarContentOrgs selected={selected} />
            ) : (
              <SidebarContent selected={selected} />
            )}
          </motion.div>
        </AnimatePresence>
        <SidebarFooter />
      </nav>
    </div>
  )
}
