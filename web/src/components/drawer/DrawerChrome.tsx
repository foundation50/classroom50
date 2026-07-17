import { Menu } from "lucide-react"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import { MOBILE_DRAWER_ID, useSidebarCollapse } from "./collapseContext"
import {
  SidebarContent,
  SidebarContentClasses,
  SidebarContentOrgs,
} from "./SidebarContent"

export const DrawerContent = ({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) => {
  const { t } = useTranslation()
  return (
    <div className={`${className} drawer-content`}>
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

export const DrawerSidebar = ({
  selected = "",
  page = "",
  settings = false,
}) => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()
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
