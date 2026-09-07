import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MortarBoardIcon,
} from "@/components/ui/icons"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import { motion } from "motion/react"
import { useSidebarCollapse } from "./collapseContext"
import {
  navItemClass,
  sidebarActivePillClass,
  sidebarTooltip,
  sidebarIconButton,
} from "./sidebarClasses"
import { sidebarPillTransition } from "@/lib/motion"
import { rtlFlip } from "@/components/ui"

// Collapse-only tooltip wrapper, used internally by SidebarNavItem below.
const Tip = ({ label, children }: { label: string; children: ReactNode }) => {
  const { collapsed } = useSidebarCollapse()
  if (!collapsed) return <>{children}</>
  return (
    <div className={`${sidebarTooltip} w-full`} data-tip={label}>
      {children}
    </div>
  )
}

// Inner markup of a sidebar nav row. Callers wrap this in `<li><Link>…` so the
// list structure stays valid (an `<li>` must be a direct child of the `<ul>`,
// with the `<Link>`/`<a>` inside it — not the other way around).
//
// Renders a plain block element (not `<li>`): the caller owns the `<li>`, so
// this must not emit a second one. `aria-current` still marks the active row.
//
// The active highlight is a single shared-`layoutId` pill per menu (`groupId`),
// so moving `active` between rows FLIP-glides it rather than snapping. The
// global MotionConfig reducedMotion="user" turns that into an instant swap when
// the user prefers reduced motion.
export const SidebarItemBody = ({
  label,
  icon,
  active,
  groupId = "sidebar",
}: {
  label: string
  icon: ReactNode
  active: boolean
  groupId?: string
}) => {
  const { collapsed } = useSidebarCollapse()
  return (
    <span
      aria-current={active ? "page" : undefined}
      className={`${navItemClass(active, collapsed)} w-full`}
    >
      {active && (
        <motion.span
          aria-hidden="true"
          layoutId={`${groupId}-active-pill`}
          className={sidebarActivePillClass}
          transition={sidebarPillTransition}
        />
      )}
      <span className="relative z-10 shrink-0">{icon}</span>
      {!collapsed && (
        <span className="sidebar-fade-in relative z-10 truncate">{label}</span>
      )}
    </span>
  )
}

// A complete sidebar nav row: the `<li>` list item wrapping the collapse tooltip
// and its typed `<Link>`. Callers pass the `<Link>` as children so router type
// inference stays intact; this owns the valid `<ul> > <li> > <a>` structure.
// The `[&_a]` rules stretch the inner Link (and the Tip wrapper) to the row
// width so the row keeps its full-width hit area and layout.
export const SidebarNavItem = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <li className="flex [&>div]:w-full [&_a]:flex [&_a]:w-full [&_a]:min-w-0">
    <Tip label={label}>{children}</Tip>
  </li>
)

export const ClassroomLogo = () => {
  const { collapsed, toggle } = useSidebarCollapse()
  const { t } = useTranslation()

  if (collapsed) {
    return (
      <div className="flex items-center justify-center px-2 py-6 border-b-1 border-neutral-content/20">
        <button
          type="button"
          onClick={toggle}
          className={`${sidebarTooltip} sidebar-fade-in cursor-pointer rounded-selector p-1 transition-colors hover:bg-[var(--sidebar-surface)]`}
          data-tip={t("nav.expandSidebar")}
          aria-label={t("nav.expandSidebar")}
        >
          <MortarBoardIcon
            aria-hidden="true"
            className="size-8 text-[var(--sidebar-accent)]"
          />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 px-6 py-6 border-b-1 border-neutral-content/20">
      <Link
        to="/"
        className="sidebar-fade-in flex flex-1 min-w-0 items-center text-lg text-neutral-content font-bold"
        title={t("nav.appName")}
      >
        <MortarBoardIcon
          aria-hidden="true"
          className="size-8 text-[var(--sidebar-accent)] shrink-0 me-2"
        />
        <span className="whitespace-nowrap">{t("nav.appName")}</span>
      </Link>
      <button
        type="button"
        onClick={toggle}
        className="sidebar-fade-in shrink-0 rounded-selector p-1 text-neutral-content/60 transition-colors hover:bg-[var(--sidebar-surface)] hover:text-neutral-content cursor-pointer"
        aria-label={t("nav.collapseSidebar")}
        title={t("nav.collapseSidebar")}
      >
        <ChevronLeftIcon aria-hidden="true" className={`size-5 ${rtlFlip}`} />
      </button>
    </div>
  )
}

export const ExpandSidebarButton = () => {
  const { collapsed, toggle } = useSidebarCollapse()
  const { t } = useTranslation()
  if (!collapsed) return null

  return (
    <div className="sidebar-fade-in flex justify-center py-2">
      <button
        type="button"
        onClick={toggle}
        className={sidebarIconButton("p-2")}
        data-tip={t("nav.expandSidebar")}
        aria-label={t("nav.expandSidebar")}
      >
        <ChevronRightIcon aria-hidden="true" className={`size-5 ${rtlFlip}`} />
      </button>
    </div>
  )
}

export const AllClasses = ({ org }: { org: string }) => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()

  if (collapsed) {
    return (
      <div className="sidebar-fade-in flex justify-center py-2 text-sm">
        <Link
          to="/$org/classes"
          params={{ org }}
          className={sidebarIconButton("p-1")}
          data-tip={t("nav.allClasses")}
          aria-label={t("nav.allClasses")}
        >
          <ArrowLeftIcon aria-hidden="true" className={`size-5 ${rtlFlip}`} />
        </Link>
      </div>
    )
  }

  return (
    <div className="sidebar-fade-in py-4 text-sm">
      <Link
        to="/$org/classes"
        params={{ org }}
        className="inline-flex items-center gap-1"
      >
        <ArrowLeftIcon
          aria-hidden="true"
          className={`size-3.5 shrink-0 ${rtlFlip}`}
        />
        {t("nav.allClassesLink")}
      </Link>
    </div>
  )
}
