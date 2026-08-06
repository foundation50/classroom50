import { Accessibility, ArrowLeft, LogIn, Menu } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { useId, useRef, type ReactNode } from "react"

import { useGithubAuth } from "@/auth/useGithubAuth"
import { useTheme } from "@/hooks/useTheme"
import { LanguageDialog } from "@/components/LanguageDialog"
import { AboutDialog } from "@/components/AboutDialog"
import { WIKI_URL } from "@/version"
import { Sun, Moon, Languages, Info, BookOpen } from "lucide-react"

import Drawer, { MOBILE_DRAWER_ID, useSidebarCollapse } from "./collapseContext"
import {
  ClassroomLogo,
  ExpandSidebarButton,
  SidebarItemBody,
} from "./primitives"
import { ThemeToggleTrack } from "./SidebarFooter"

// A minimal, dependency-free app shell for PUBLIC pages (currently the
// accessibility report). It reuses the drawer's layout + branding — the drawer
// container, the Classroom 50 logo, the collapse control, and the theme /
// language / About / Docs footer — but NOT the authenticated sidebar (MyOrgs /
// SidebarFooter), which depends on org-role context that only exists inside the
// `_authed` tree and throws elsewhere. So this shell has no GitHub-client,
// org, or role hooks: it renders identically whether the visitor is signed in
// or not, giving an ADA/VPAT reviewer the app's look and a clear way back
// without requiring a login.

// The single nav row: an adaptive "way back" — Back to app when signed in,
// otherwise Sign in — plus the current-page (Accessibility) row.
function PublicSidebarNav() {
  const { t } = useTranslation()
  const { status } = useGithubAuth()
  const signedIn = status === "authenticated"

  return (
    <nav aria-label={t("nav.primary")} className="py-4">
      <ul className="flex flex-col gap-1">
        <li className="flex [&_a]:flex [&_a]:w-full [&_a]:min-w-0">
          {signedIn ? (
            <Link to="/">
              <SidebarItemBody
                label={t("nav.backToApp")}
                icon={<ArrowLeft aria-hidden="true" />}
                active={false}
                groupId="public"
              />
            </Link>
          ) : (
            <Link to="/login">
              <SidebarItemBody
                label={t("nav.signIn")}
                icon={<LogIn aria-hidden="true" />}
                active={false}
                groupId="public"
              />
            </Link>
          )}
        </li>
        <li className="flex [&_a]:flex [&_a]:w-full [&_a]:min-w-0">
          <Link to="/accessibility">
            <SidebarItemBody
              label={t("nav.accessibility")}
              icon={<Accessibility aria-hidden="true" />}
              active
              groupId="public"
            />
          </Link>
        </li>
      </ul>
    </nav>
  )
}

// The footer info controls (theme, language, about, docs) shared with the
// authed footer's look, but standalone: no account/role chrome.
function PublicSidebarFooter() {
  const { t } = useTranslation()
  const { isDark, toggleTheme } = useTheme()
  const langDialogRef = useRef<HTMLDialogElement | null>(null)
  const aboutDialogRef = useRef<HTMLDialogElement | null>(null)
  const langTitleId = useId()
  const aboutTitleId = useId()
  const { collapsed } = useSidebarCollapse()

  return (
    <div className="mt-auto border-t border-neutral-content/20 py-2">
      <ul className="menu w-full gap-1">
        <li>
          <button type="button" onClick={toggleTheme} aria-pressed={isDark}>
            {isDark ? (
              <Moon aria-hidden="true" className="size-4" />
            ) : (
              <Sun aria-hidden="true" className="size-4" />
            )}
            {!collapsed && (
              <>
                <span className="flex-1 text-start">
                  {isDark ? t("nav.darkMode") : t("nav.lightMode")}
                </span>
                <ThemeToggleTrack on={isDark} />
              </>
            )}
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => langDialogRef.current?.showModal()}
          >
            <Languages aria-hidden="true" className="size-4" />
            {!collapsed && (
              <span className="flex-1 text-start">{t("nav.language")}</span>
            )}
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => aboutDialogRef.current?.showModal()}
          >
            <Info aria-hidden="true" className="size-4" />
            {!collapsed && (
              <span className="flex-1 text-start">{t("nav.about")}</span>
            )}
          </button>
        </li>
        <li>
          <a href={WIKI_URL} target="_blank" rel="noreferrer">
            <BookOpen aria-hidden="true" className="size-4" />
            {!collapsed && (
              <span className="flex-1 text-start">{t("nav.docs")}</span>
            )}
          </a>
        </li>
      </ul>

      {createPortal(
        <>
          <LanguageDialog ref={langDialogRef} titleId={langTitleId} />
          <AboutDialog ref={aboutDialogRef} titleId={aboutTitleId} />
        </>,
        document.body,
      )}
    </div>
  )
}

// The public sidebar: same rail chrome (logo + collapse) as the authed drawer,
// with the minimal nav + footer above.
function PublicSidebar() {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()
  return (
    <div className="drawer-side z-40">
      <label htmlFor={MOBILE_DRAWER_ID} className="drawer-overlay">
        <span className="sr-only">{t("nav.closeMenu")}</span>
      </label>
      <div
        className={`flex flex-col min-h-full bg-neutral text-neutral-content transition-[width] duration-200 ease-out ${
          collapsed
            ? "w-16 min-w-16 [&>div]:px-2 [&>nav]:px-2"
            : "w-60 min-w-30 [&>div]:px-6 [&>nav]:px-6"
        }`}
      >
        <ClassroomLogo />
        <ExpandSidebarButton />
        <PublicSidebarNav />
        <PublicSidebarFooter />
      </div>
    </div>
  )
}

// Public app shell: the drawer layout wrapping a public page. Mirrors AppShell's
// structure (drawer container + toggle + content + sidebar) but with the
// dependency-free public sidebar, so it renders for logged-out visitors.
export function PublicAppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen">
      <Drawer>
        <input
          id={MOBILE_DRAWER_ID}
          type="checkbox"
          className="drawer-toggle"
          aria-hidden="true"
          tabIndex={-1}
        />
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
        <PublicSidebar />
      </Drawer>
    </div>
  )
}

export default PublicAppShell
