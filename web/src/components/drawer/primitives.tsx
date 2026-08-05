import {
  GraduationCap,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
} from "lucide-react"
import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import { motion } from "motion/react"
import type { Classroom } from "@/types/classroom"
import { useSidebarCollapse } from "./collapseContext"
import {
  navItemClass,
  sidebarActivePillClass,
  sidebarTooltip,
  sidebarIconButton,
} from "./sidebarClasses"
import { sidebarPillTransition } from "@/lib/motion"
import { rtlFlip } from "@/components/ui"

export const Tip = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => {
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
      {!collapsed && <span className="relative z-10 truncate">{label}</span>}
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
          className={`${sidebarTooltip} cursor-pointer rounded-md p-1 transition-colors hover:bg-[var(--sidebar-surface)]`}
          data-tip={t("nav.expandSidebar")}
          aria-label={t("nav.expandSidebar")}
        >
          <GraduationCap
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
        className="flex flex-1 min-w-0 items-center text-lg text-neutral-content font-bold"
        title={t("nav.appName")}
      >
        <GraduationCap
          aria-hidden="true"
          className="size-8 text-[var(--sidebar-accent)] shrink-0 me-2"
        />
        <span className="whitespace-nowrap">{t("nav.appName")}</span>
      </Link>
      <button
        type="button"
        onClick={toggle}
        className="shrink-0 rounded-md p-1 text-neutral-content/60 transition-colors hover:bg-[var(--sidebar-surface)] hover:text-neutral-content cursor-pointer"
        aria-label={t("nav.collapseSidebar")}
        title={t("nav.collapseSidebar")}
      >
        <ChevronLeft aria-hidden="true" className={`size-5 ${rtlFlip}`} />
      </button>
    </div>
  )
}

export const ExpandSidebarButton = () => {
  const { collapsed, toggle } = useSidebarCollapse()
  const { t } = useTranslation()
  if (!collapsed) return null

  return (
    <div className="flex justify-center py-2">
      <button
        type="button"
        onClick={toggle}
        className={sidebarIconButton("p-2")}
        data-tip={t("nav.expandSidebar")}
        aria-label={t("nav.expandSidebar")}
      >
        <ChevronRight aria-hidden="true" className={`size-5 ${rtlFlip}`} />
      </button>
    </div>
  )
}

export const AllClasses = ({ org }: { org: string }) => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()

  if (collapsed) {
    return (
      <div className="flex justify-center py-2 text-sm">
        <Link
          to="/$org/classes"
          params={{ org }}
          className={sidebarIconButton("p-1")}
          data-tip={t("nav.allClasses")}
          aria-label={t("nav.allClasses")}
        >
          <ArrowLeft aria-hidden="true" className={`size-5 ${rtlFlip}`} />
        </Link>
      </div>
    )
  }

  return (
    <div className="py-4 text-sm">
      <Link
        to="/$org/classes"
        params={{ org }}
        className="inline-flex items-center gap-1"
      >
        <ArrowLeft
          aria-hidden="true"
          className={`size-3.5 shrink-0 ${rtlFlip}`}
        />
        {t("nav.allClassesLink")}
      </Link>
    </div>
  )
}

export const SidebarClassInfo = ({ classInfo }: { classInfo?: Classroom }) => {
  const { classroom } = useParams({ strict: false })
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()

  if (collapsed) return null

  return (
    <div className="py-2">
      <h3 className="font-bold">
        {classInfo?.name ||
          classInfo?.short_name ||
          classroom ||
          t("nav.untitledCourse")}
      </h3>
      <p className="text-gray-400 text-sm">{classInfo?.term ?? ""}</p>
    </div>
  )
}
