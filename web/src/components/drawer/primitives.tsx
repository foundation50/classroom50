import {
  GraduationCap,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
} from "lucide-react"
import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { type ReactNode } from "react"
import type { Classroom } from "@/types/classroom"
import { useSidebarCollapse } from "./collapseContext"
import {
  navItemClass,
  sidebarTooltip,
  sidebarIconButton,
} from "./sidebarClasses"
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

// Inner markup of a sidebar nav row. Callers keep their own typed <Link to
// params> around this so router type inference stays intact.
export const SidebarItemBody = ({
  label,
  icon,
  active,
}: {
  label: string
  icon: ReactNode
  active: boolean
}) => {
  const { collapsed } = useSidebarCollapse()
  return (
    <li
      aria-current={active ? "page" : undefined}
      className={navItemClass(active, collapsed)}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
    </li>
  )
}

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
