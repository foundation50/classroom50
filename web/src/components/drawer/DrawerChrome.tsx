import { ThreeBarsIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import { Outlet, useRouterState } from "@tanstack/react-router"
import { AnimatePresence, motion } from "motion/react"
import Drawer, { MOBILE_DRAWER_ID, useSidebarCollapse } from "./collapseContext"
import {
  SidebarContent,
  SidebarContentClasses,
  SidebarContentOrgs,
} from "./SidebarContent"
import { ClassroomLogo, ExpandSidebarButton } from "./primitives"
import { SidebarFooter } from "./SidebarFooter"
import { AccessibilitySidebarNav } from "./AccessibilitySidebarNav"
import { useSidebarNav } from "./useSidebarNav"
import { sidebarLevelVariants, pageContentVariants } from "@/lib/motion"

// Replays a subtle enter animation on each route swap. Keying the motion element
// by pathname remounts it, so it plays `initial -> animate` once per navigation
// — no AnimatePresence/exit, so the incoming page never waits behind an outgoing
// one (navigation stays instant). Banners stay outside this so they don't
// re-animate on every navigation.
const PageTransition = ({ children }: { children: ReactNode }) => {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <motion.div
      key={pathname}
      variants={pageContentVariants}
      initial="initial"
      animate="animate"
    >
      {children}
    </motion.div>
  )
}

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
        <PageTransition>
          <Outlet />
        </PageTransition>
      </DrawerContent>
      <DrawerSidebar />
    </Drawer>
  </div>
)

// The same drawer chrome as AppShell, but rendering `children` instead of an
// <Outlet/>. Public routes (e.g. /accessibility) mount their page inside this
// so they get the real, auth-aware drawer without being nested under _authed.
export const DrawerShell = ({ children }: { children: ReactNode }) => (
  <div className="min-h-screen">
    <Drawer>
      <DrawerToggle />
      <DrawerContent>{children}</DrawerContent>
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
    // White canvas per GitHub Product UI: content sits on base-100 and muted
    // panels/cards carry the base-200 gray.
    <div className="drawer-content min-h-screen bg-base-100">
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
        <ThreeBarsIcon className="size-6" aria-hidden="true" />
      </label>
      <main id="main-content">{children}</main>
    </div>
  )
}

// DaisyUI's drawer state lives in this checkbox, toggled by the labeled
// open/close buttons above (which carry their own aria-labels). The input
// itself is a headless layout control, so hide it from assistive tech and keep
// it out of the tab order — otherwise it surfaces as a stray unlabeled checkbox.
export const DrawerToggle = () => (
  <input
    id={MOBILE_DRAWER_ID}
    type="checkbox"
    className="drawer-toggle"
    aria-hidden="true"
    tabIndex={-1}
  />
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
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // The accessibility page is public and section-navigated, so its rail shows
  // the section deep links (not the org/class menus) for every visitor —
  // signed-in users still get a "Back to app" row and the full account footer.
  const onAccessibility = pathname.replace(/\/$/, "") === "/accessibility"
  const { page, selected, settings, levelKey } = useSidebarNav()
  return (
    <div className="drawer-side z-40">
      {/* DaisyUI click-outside scrim to close the mobile drawer (the htmlFor
          toggles the drawer checkbox with no JS). A bare <label> has
          role=generic, which prohibits aria-label (axe aria-prohibited-attr);
          give it visually-hidden text instead so it has an accessible name via
          real content and stays associated with its control (eslint
          label-has-associated-control). */}
      <label htmlFor={MOBILE_DRAWER_ID} className="drawer-overlay">
        <span className="sr-only">{t("nav.closeMenu")}</span>
      </label>
      <nav
        aria-label={t("nav.primary")}
        className={`flex flex-col min-h-full sidebar-rail text-neutral-content transition-[width] duration-200 ease-out ${
          collapsed
            ? "w-16 min-w-16 [&>div]:px-2"
            : "w-60 min-w-30 [&>div]:px-6"
        }`}
      >
        <ClassroomLogo />
        <ExpandSidebarButton />
        {onAccessibility ? (
          <AccessibilitySidebarNav />
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={levelKey}
              variants={sidebarLevelVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {page === "classes" ? (
                <SidebarContentClasses
                  selected={selected}
                  settings={settings}
                />
              ) : page === "orgs" ? (
                <SidebarContentOrgs selected={selected} />
              ) : (
                <SidebarContent selected={selected} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
        <SidebarFooter />
      </nav>
    </div>
  )
}
