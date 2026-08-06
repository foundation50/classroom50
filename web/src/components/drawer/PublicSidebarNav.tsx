import { LogIn } from "lucide-react"
import { Link, useRouterState } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import {
  ACCESSIBILITY_SECTIONS,
  sectionFromHash,
} from "@/util/a11y/accessibilitySections"
import { useSidebarCollapse } from "./collapseContext"
import { SidebarItemBody, SidebarNavItem } from "./primitives"

// The sidebar BODY shown to signed-out visitors (currently only /accessibility
// is public). A Sign in row plus the accessibility page's section deep links,
// so the real app drawer stays usable without a login — the authed org/class
// menus (which need a GitHub client) are never mounted here.
export function PublicSidebarNav() {
  const { t } = useTranslation()
  const { collapsed } = useSidebarCollapse()
  const hash = useRouterState({ select: (s) => s.location.hash })
  const activeSection = sectionFromHash(hash)

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <SidebarNavItem label={t("nav.signIn")}>
          <Link to="/login">
            <SidebarItemBody
              label={t("nav.signIn")}
              icon={<LogIn aria-hidden="true" />}
              active={false}
              groupId="public"
            />
          </Link>
        </SidebarNavItem>
      </ul>

      <ul
        className="menu mt-2 w-full gap-1"
        aria-label={t("nav.accessibility")}
      >
        {!collapsed && (
          <li className="menu-title text-neutral-content/70">
            {t("nav.accessibility")}
          </li>
        )}
        {ACCESSIBILITY_SECTIONS.map((s) => {
          const active = activeSection === s.id
          return (
            <li key={s.id}>
              <Link
                to="/accessibility"
                hash={s.id}
                // Match the hash too, so the shared "/accessibility" pathname
                // doesn't mark every section active; aria-current/style come
                // from activeSection since the default (no hash) is conformance.
                activeOptions={{ exact: true, includeHash: true }}
                aria-current={active ? "page" : undefined}
                className={active ? "menu-active" : undefined}
                title={collapsed ? t(s.labelKey) : undefined}
              >
                {collapsed ? (
                  <span className="sr-only">{t(s.labelKey)}</span>
                ) : (
                  <span className="flex-1 text-start">{t(s.labelKey)}</span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default PublicSidebarNav
