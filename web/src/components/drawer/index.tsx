import {
  GraduationCap,
  BookText,
  UsersRound,
  LogOut,
  Settings,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  Menu,
  FileCheck2,
  FilePlus2,
  Globe,
  Eye,
  Check,
  Sun,
  Moon,
  Languages,
  Info,
  BookOpen,
  Activity,
} from "lucide-react"
import {
  Link,
  useParams,
  useMatchRoute,
  useMatch,
  useNavigate,
} from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useGithubAuth } from "../../auth/useGithubAuth"
import GitHub from "@/assets/github.svg?react"
import duck from "@/assets/duck.png"
import { useConfigRepoAccess } from "../../hooks/useConfigRepoAccess"
import {
  useClassroomRoleContext,
  useClassroomRoleContextOptional,
} from "@/context/classroomRole/ClassroomRoleProvider"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"
import { roleLabelKey, isStaffRole, type ViewAsRole } from "@/util/resolveRole"
import { useRoleView } from "@/context/roleView/RoleViewProvider"
import useGetClassroom from "@/hooks/useGetClassroom"
import useGetOrgMembership from "@/hooks/useGetOrgMembership"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import { studentRepoName } from "@/util/studentRepo"
import { githubOrgUrl } from "@/util/orgUrl"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useTheme } from "@/hooks/useTheme"
import { LanguageDialog } from "@/components/LanguageDialog"
import { AboutDialog } from "@/components/AboutDialog"
import { WIKI_URL } from "@/version"
import type { Classroom } from "@/types/classroom"
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

const SIDEBAR_COLLAPSED_KEY = "classroom50:sidebar-collapsed"
const MOBILE_DRAWER_ID = "app-drawer"

type SidebarCollapseContextValue = {
  collapsed: boolean
  toggle: () => void
}

const SidebarCollapseContext = createContext<SidebarCollapseContextValue>({
  collapsed: false,
  toggle: () => {},
})

const useSidebarCollapse = () => useContext(SidebarCollapseContext)

const Drawer = ({ children }: { children: ReactNode }) => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  })

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  return (
    <SidebarCollapseContext.Provider
      value={{ collapsed, toggle: () => setCollapsed((value) => !value) }}
    >
      <div className="drawer lg:drawer-open">{children}</div>
    </SidebarCollapseContext.Provider>
  )
}

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
        className="btn btn-primary btn-sm sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
      >
        {t("common.skipToMainContent")}
      </a>
      <label
        htmlFor={MOBILE_DRAWER_ID}
        aria-label={t("nav.openMenu")}
        className="btn btn-ghost btn-square fixed top-3 left-3 z-30 lg:hidden"
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

const navItemClass = (active: boolean, collapsed: boolean) =>
  `flex items-center gap-2 rounded-box border-l-2 px-2 py-2 transition-colors ${
    collapsed ? "justify-center" : ""
  } ${
    active
      ? "border-[var(--sidebar-accent)] bg-[var(--sidebar-surface)]"
      : "border-transparent hover:bg-[var(--sidebar-surface)]/60"
  }`

// Shared sidebar tooltip tokens (dark rail): bubble + text colors every
// collapsed-sidebar tooltip uses. One source so a token rename lands once.
const sidebarTooltip =
  "tooltip tooltip-right [--tt-bg:var(--sidebar-surface)] before:text-neutral-content"

// Interactive icon-button row in the rail (back-links, collapse/expand): tooltip
// base plus a muted icon that lightens and gains a surface on hover.
const sidebarIconButton = (padding: "p-1" | "p-2" = "p-1") =>
  `${sidebarTooltip} cursor-pointer rounded-md ${padding} text-neutral-content/60 transition-colors hover:bg-[var(--sidebar-surface)] hover:text-neutral-content`

const Tip = ({ label, children }: { label: string; children: ReactNode }) => {
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
const SidebarItemBody = ({
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
          className="size-8 text-[var(--sidebar-accent)] shrink-0 mr-2"
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
        <ChevronLeft aria-hidden="true" className="size-5" />
      </button>
    </div>
  )
}

const ExpandSidebarButton = () => {
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
        <ChevronRight aria-hidden="true" className="size-5" />
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
          <ArrowLeft aria-hidden="true" className="size-5" />
        </Link>
      </div>
    )
  }

  return (
    <div className="py-4 text-sm">
      <Link to="/$org/classes" params={{ org }} className="text-center">
        {t("nav.allClassesArrow")}
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

const AssignmentSidebarMenu = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: string
}) => {
  const { collapsed } = useSidebarCollapse()
  const { t } = useTranslation()
  const { showTeacherUi, roleResolved, actualRole } = useClassroomRoleContext()
  const matchRoute = useMatchRoute()
  const { user } = useGithubAuth()

  // Resolve the display name from whichever source the role can read. The
  // teacher config-repo source is role-gated so a student doesn't fire a
  // guaranteed 404; the public Pages source covers the student (and is a
  // teacher fallback before Pages publishes).
  const { data: teacherAssignments } = useGetClassroomAssignments(
    org,
    classroom,
    { enabled: showTeacherUi },
  )
  // A protected classroom's public Pages fetch needs the capability secret. A
  // student reads it from their own repo's .classroom50.yaml (their only
  // source); a teacher gets it from classroom.json. Gate the classroom.json read
  // on the viewer's ACTUAL role (not the preview) so an instructor previewing as
  // a student still resolves the secret for a working accept link — a real
  // student's read stays disabled (guaranteed 404).
  const studentRepoNameForSecret = user?.login
    ? studentRepoName(classroom, assignment, user.login)
    : ""
  const { secret: studentSecret } = useDotClassroom50(
    org,
    studentRepoNameForSecret,
  )
  const isActuallyStaff = isStaffRole(actualRole) && actualRole !== "unresolved"
  const { data: classroomMeta } = useGetClassroom(org, classroom, {
    enabled: isActuallyStaff,
  })
  const secret = studentSecret || classroomMeta?.secret
  const { assignment: publicAssignment } = useGetPublicAssignment(
    org,
    classroom,
    assignment,
    secret,
  )
  const assignmentName =
    teacherAssignments?.assignments.find((a) => a.slug === assignment)?.name ||
    publicAssignment?.name ||
    assignment

  // Group assignments give students collaborators to manage; individual
  // assignments have nothing student-editable, so we omit the settings entry
  // rather than route to a dead-end.
  const isGroupAssignment = publicAssignment?.mode === "group"

  const onRoute = (to: Parameters<typeof matchRoute>[0]["to"]) =>
    Boolean(matchRoute({ to, fuzzy: false }))

  const onSubmissions =
    onRoute("/$org/$classroom/assignments/$assignment/submissions") ||
    onRoute("/$org/$classroom/assignments/$assignment")
  const onSubmission = onRoute(
    "/$org/$classroom/assignments/$assignment/submission",
  )
  const onSettings = onRoute("/$org/$classroom/assignments/$assignment/edit")
  const onAccept = onRoute("/$org/$classroom/assignments/$assignment/accept")

  // Students only: surface "Accept" until they have their repo. Hidden while
  // loading (avoid a flash) and for a real staffer previewing as a student —
  // they have no student repo, so "Accept" would dead-end.
  const { assignment: studentRepo, isLoading: repoLoading } =
    useGetAssignmentRepo(org, classroom, assignment, user?.login)
  const showAccept =
    !showTeacherUi &&
    !isActuallyStaff &&
    roleResolved &&
    !repoLoading &&
    !studentRepo

  return (
    <>
      {collapsed ? (
        <div className="flex justify-center py-2 text-sm">
          <Link
            to="/$org/$classroom/assignments"
            params={{ org, classroom }}
            className={sidebarIconButton("p-1")}
            data-tip={t("nav.allAssignments")}
            aria-label={t("nav.allAssignments")}
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </Link>
        </div>
      ) : (
        <div className="py-4 text-sm">
          <Link to="/$org/$classroom/assignments" params={{ org, classroom }}>
            {t("nav.allAssignmentsArrow")}
          </Link>
        </div>
      )}

      {!collapsed && (
        <div className="py-2">
          <h3 className="font-bold leading-tight">{assignmentName}</h3>
          <p className="text-gray-400 text-sm">{t("nav.assignment")}</p>
        </div>
      )}

      <div className="py-4">
        <ul className="flex flex-col gap-1">
          {!roleResolved ? (
            <>
              {[0, 1].map((i) => (
                <li key={i} className="flex px-2 py-2">
                  <span className="skeleton h-4 w-24 bg-neutral-content/10" />
                </li>
              ))}
            </>
          ) : showTeacherUi ? (
            <>
              <Tip label={t("nav.submissions")}>
                <Link
                  to="/$org/$classroom/assignments/$assignment/submissions"
                  params={{ org, classroom, assignment }}
                >
                  <SidebarItemBody
                    label={t("nav.submissions")}
                    icon={<UsersRound aria-hidden="true" />}
                    active={onSubmissions}
                  />
                </Link>
              </Tip>
              <Tip label={t("nav.settings")}>
                <Link
                  to="/$org/$classroom/assignments/$assignment/edit"
                  params={{ org, classroom, assignment }}
                >
                  <SidebarItemBody
                    label={t("nav.settings")}
                    icon={<Settings aria-hidden="true" />}
                    active={onSettings}
                  />
                </Link>
              </Tip>
            </>
          ) : (
            <>
              {showAccept && (
                <Tip label={t("nav.acceptAssignment")}>
                  <Link
                    to="/$org/$classroom/assignments/$assignment/accept"
                    params={{ org, classroom, assignment }}
                    search={secret ? { k: secret } : undefined}
                  >
                    <SidebarItemBody
                      label={t("nav.acceptAssignment")}
                      icon={<FilePlus2 aria-hidden="true" />}
                      active={onAccept}
                    />
                  </Link>
                </Tip>
              )}
              <Tip label={t("nav.mySubmission")}>
                <Link
                  to="/$org/$classroom/assignments/$assignment/submission"
                  params={{ org, classroom, assignment }}
                >
                  <SidebarItemBody
                    label={t("nav.mySubmission")}
                    icon={<FileCheck2 aria-hidden="true" />}
                    active={onSubmission}
                  />
                </Link>
              </Tip>
              {isGroupAssignment && (
                <Tip label={t("nav.manageGroup")}>
                  <Link
                    to="/$org/$classroom/assignments/$assignment/edit"
                    params={{ org, classroom, assignment }}
                  >
                    <SidebarItemBody
                      label={t("nav.manageGroup")}
                      icon={<UsersRound aria-hidden="true" />}
                      active={onSettings}
                    />
                  </Link>
                </Tip>
              )}
            </>
          )}
        </ul>
      </div>
    </>
  )
}

export const TeacherSidebarMenu = ({
  org,
  classroom,
  selected,
}: {
  org: string
  classroom: string
  selected: string
}) => {
  // Placeholder while pending so items never flash in then out.
  const {
    showTeacherUi,
    roleResolved,
    role: classroomRole,
  } = useClassroomRoleContext()
  // Finer, preview-aware classroom role. Roster is staff-only, Settings
  // instructor-only; gating on this makes "View as student/TA" faithfully hide
  // what a real student/TA wouldn't see. `unresolved` is permissive (no flash).
  const showStaffItems = showTeacherUi && isStaffRole(classroomRole)
  const canEditSettings = can("editClassroomSettings", {
    classroomRole,
  })
  const { t } = useTranslation()

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <Tip label={t("nav.assignments")}>
          <Link to="/$org/$classroom/assignments" params={{ org, classroom }}>
            <SidebarItemBody
              label={t("nav.assignments")}
              icon={<BookText aria-hidden="true" />}
              active={selected === "assignments"}
            />
          </Link>
        </Tip>
        {!roleResolved ? (
          <>
            {[0, 1].map((i) => (
              <li key={i} className="flex px-2 py-2">
                <span className="skeleton h-4 w-24 bg-neutral-content/10" />
              </li>
            ))}
          </>
        ) : (
          showStaffItems && (
            <>
              <Tip label={t("nav.roster")}>
                <Link to="/$org/$classroom/roster" params={{ org, classroom }}>
                  <SidebarItemBody
                    label={t("nav.roster")}
                    icon={<UsersRound aria-hidden="true" />}
                    active={selected === "roster"}
                  />
                </Link>
              </Tip>
              {canEditSettings && (
                <Tip label={t("nav.settings")}>
                  <Link to="/$org/$classroom/edit" params={{ org, classroom }}>
                    <SidebarItemBody
                      label={t("nav.settings")}
                      icon={<Settings aria-hidden="true" />}
                      active={selected === "settings"}
                    />
                  </Link>
                </Tip>
              )}
            </>
          )
        )}
      </ul>
    </div>
  )
}

export const SidebarFooter = () => {
  const { signOut, user } = useGithubAuth()
  const { t } = useTranslation()
  const avatar_img = user?.avatar_url || duck
  const name = user?.name || user?.login || t("nav.userFallback")
  const { org, classroom, assignment } = useParams({ strict: false })
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  const isOrgSetup = !!useMatch({
    from: "/_authed/$org/setup/",
    shouldThrow: false,
  })
  const { isStudent, isLoading: roleLoading } = useConfigRepoAccess(org)
  // Org plan for the About-dialog diagnostics snapshot. Cached and shared with
  // the setup/audit panes; `plan` is only visible to org owners, so this is
  // often undefined (the snapshot then reports "unknown" with a reason).
  const { data: orgPlanDetails } = useGetOrgPlanDetails(org)
  // Precise classroom role (Instructor vs TA); respects the "view as" preview.
  // `actualRole` is the real (preview-independent) role. Null off a classroom
  // route (no provider), where the org-level label logic below applies instead.
  const classroomCtx = useClassroomRoleContextOptional()
  const classroomRole = classroomCtx?.role ?? "unresolved"
  const actualClassroomRole = classroomCtx?.actualRole ?? "unresolved"
  const classroomRoleLoading = classroomCtx?.isLoading ?? false
  const { viewAs, setViewAs } = useRoleView()
  // Offer "View as" only to a real instructor of THIS classroom — the role with
  // something lower to preview. Keyed off instructor-team membership, not
  // org-admin status (KTD-4). Uses the REAL role (actualClassroomRole), not the
  // preview-clamped one.
  const canPreviewRoles =
    Boolean(classroom) &&
    can("previewAsRole", { classroomRole: actualClassroomRole })

  // Apply a "view as" change and, if the current route is role-specific, move to
  // the analogous route for the new role so the user isn't stranded.
  const selectViewAs = (next: ViewAsRole | null) => {
    setViewAs(next)
    if (!org || !classroom || !assignment) return
    const params = { org, classroom, assignment }
    const onStudentSubmission = matchRoute({
      to: "/$org/$classroom/assignments/$assignment/submission",
      fuzzy: false,
    })
    const onStaffSubmissions = matchRoute({
      to: "/$org/$classroom/assignments/$assignment/submissions",
      fuzzy: false,
    })
    const onStaffEdit = matchRoute({
      to: "/$org/$classroom/assignments/$assignment/edit",
      fuzzy: false,
    })
    // -> student view on a staff-only assignment page: land on the student
    // per-assignment page, not a staff surface.
    if (next === "student" && (onStaffSubmissions || onStaffEdit)) {
      void navigate({
        to: "/$org/$classroom/assignments/$assignment/submission",
        params,
      })
    } else if (next !== "student" && onStudentSubmission) {
      // -> staff view on the student submission page: go to the gradebook.
      void navigate({
        to: "/$org/$classroom/assignments/$assignment/submissions",
        params,
      })
    }
  }
  // Org-admin signal for org-level routes (no classroom): only an owner gets a
  // definite "Instructor" label. A non-owner staffer's role is per-classroom, so
  // leave it blank rather than mislabel a TA as Instructor.
  const { data: orgMembership, isLoading: orgMembershipLoading } =
    useGetOrgMembership(org)
  const isOwner = orgMembership?.role === "admin"

  // Role label per product mapping (owner shows as Instructor). On a classroom
  // route use the precise role; on org-level routes assert only owner or a
  // definite student, else blank.
  let roleLabelText: string | null
  if (classroom) {
    const key = classroomRoleLoading ? null : roleLabelKey(classroomRole)
    roleLabelText = key ? t(key) : null
  } else if (isOrgSetup || isOwner) {
    roleLabelText = t("nav.roleInstructor")
  } else if (!orgMembershipLoading && !roleLoading && isStudent) {
    roleLabelText = t("nav.roleStudent")
  } else {
    roleLabelText = null
  }
  const labelPending = classroom
    ? classroomRoleLoading
    : roleLoading || orgMembershipLoading

  const [menuOpen, setMenuOpen] = useState(false)
  const footerRef = useRef<HTMLDivElement | null>(null)
  const langDialogRef = useRef<HTMLDialogElement | null>(null)
  const langDialogTitleId = useId()
  const aboutDialogRef = useRef<HTMLDialogElement | null>(null)
  const aboutDialogTitleId = useId()
  const { collapsed } = useSidebarCollapse()
  const { isDark, toggleTheme } = useTheme()

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!footerRef.current) return

      if (!footerRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [menuOpen])

  return (
    <>
      {org ? (
        <a
          href={githubOrgUrl(org)}
          target="_blank"
          rel="noreferrer"
          title={t("common.openOrgOnGitHub", { org })}
          className={`mt-auto block border-t border-neutral-content/20 py-2 text-neutral-content/70 transition-colors hover:text-neutral-content ${collapsed ? "flex justify-center px-2" : "px-6"}`}
        >
          {collapsed ? (
            <GitHub aria-hidden="true" className="size-4 shrink-0 opacity-80" />
          ) : (
            <>
              <span className="block text-[0.625rem] font-medium uppercase tracking-wide text-neutral-content/50">
                {t("classes.githubOrganization")}
              </span>
              <span className="block break-words font-mono text-xs font-semibold text-neutral-content">
                {org}
              </span>
            </>
          )}
        </a>
      ) : null}
      <div
        ref={footerRef}
        className={`relative cursor-pointer border-t border-neutral-content/20 py-3 transition-colors hover:bg-[var(--sidebar-surface)]/60 ${org ? "" : "mt-auto"}`}
        onClick={() => setMenuOpen((open) => !open)}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("nav.accountMenu")}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            setMenuOpen((open) => !open)
          }

          if (event.key === "Escape") {
            setMenuOpen(false)
          }
        }}
      >
        <div
          className={`
        absolute bottom-full z-50 mb-3
        ${collapsed ? "left-2 w-48" : "left-6 right-6"}
        origin-bottom rounded-box
        transition-all duration-150 ease-out

        ${
          menuOpen
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-2 scale-95 opacity-0"
        }
      `}
          onClick={(event) => event.stopPropagation()}
        >
          <ul className="menu w-full rounded-box border border-base-300 bg-base-100 p-2 text-base-content shadow-xl">
            {canPreviewRoles && (
              <>
                <li>
                  <details key={menuOpen ? "open" : "closed"}>
                    <summary>
                      <Eye aria-hidden="true" className="size-4" />
                      <span className="flex-1">{t("nav.viewAs")}</span>
                    </summary>
                    <ul>
                      {(["self", "ta", "student"] as const).map((option) => {
                        const active =
                          option === "self"
                            ? viewAs === null
                            : viewAs === option
                        const label =
                          option === "self"
                            ? t("nav.viewAsMyself", {
                                role: (() => {
                                  const key = roleLabelKey(actualClassroomRole)
                                  return key
                                    ? t(key)
                                    : t("nav.viewAsMyselfFallback")
                                })(),
                              })
                            : option === "ta"
                              ? t("nav.viewAsTA")
                              : t("nav.viewAsStudent")
                        return (
                          <li key={option}>
                            <button
                              type="button"
                              className={active ? "active font-semibold" : ""}
                              onClick={() => {
                                selectViewAs(option === "self" ? null : option)
                                setMenuOpen(false)
                              }}
                            >
                              {active ? (
                                <Check aria-hidden="true" className="size-4" />
                              ) : (
                                <span className="size-4" />
                              )}
                              {label}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                </li>
                <div className="divider my-1" />
              </>
            )}
            <li>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleTheme()
                }}
                aria-pressed={isDark}
              >
                {isDark ? (
                  <Moon aria-hidden="true" className="size-4" />
                ) : (
                  <Sun aria-hidden="true" className="size-4" />
                )}
                <span className="flex-1 text-left">
                  {isDark ? t("nav.darkMode") : t("nav.lightMode")}
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-sm toggle-primary pointer-events-none"
                  checked={isDark}
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setMenuOpen(false)
                  langDialogRef.current?.showModal()
                }}
              >
                <Languages aria-hidden="true" className="size-4" />
                <span className="flex-1 text-left">{t("nav.language")}</span>
              </button>
            </li>
            <div className="divider my-1" />
            <li>
              <a
                href={WIKI_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.stopPropagation()
                  setMenuOpen(false)
                }}
              >
                <BookOpen aria-hidden="true" className="size-4" />
                <span className="flex-1 text-left">{t("nav.docs")}</span>
              </a>
            </li>
            <li>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setMenuOpen(false)
                  aboutDialogRef.current?.showModal()
                }}
              >
                <Info aria-hidden="true" className="size-4" />
                <span className="flex-1 text-left">{t("nav.about")}</span>
              </button>
            </li>

            <li>
              <button type="button" className="text-error" onClick={signOut}>
                <LogOut aria-hidden="true" className="size-4" />
                {t("nav.signOut")}
              </button>
            </li>
          </ul>
        </div>

        <div
          className={`flex w-full items-center gap-2.5 text-left ${collapsed ? "justify-center" : "justify-start"}`}
          title={collapsed ? name : undefined}
        >
          <div className="avatar avatar-placeholder">
            <img
              src={avatar_img}
              alt={t("nav.avatarAlt", { name })}
              className={`rounded-full ${collapsed ? "w-7" : "w-8"}`}
            />
          </div>

          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-neutral-content">
                {name}
              </div>

              {org ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-neutral-content/60">
                    {labelPending ? (
                      <span className="skeleton inline-block h-3 w-16 align-middle bg-neutral-content/10" />
                    ) : (
                      roleLabelText
                    )}
                  </span>
                  {viewAs && canPreviewRoles ? (
                    <span
                      className="badge badge-warning badge-xs gap-1"
                      title={t("nav.rolePreviewTooltip")}
                    >
                      <Eye aria-hidden="true" className="size-3" />
                      {t("nav.preview")}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {createPortal(
        <LanguageDialog ref={langDialogRef} titleId={langDialogTitleId} />,
        document.body,
      )}

      {createPortal(
        <AboutDialog
          ref={aboutDialogRef}
          titleId={aboutDialogTitleId}
          org={org}
          planName={orgPlanDetails?.plan?.name}
        />,
        document.body,
      )}
    </>
  )
}

export const SidebarContent = ({ selected }: { selected: string }) => {
  const { org, classroom, assignment } = useParams({ strict: false })
  const { data: classData } = useGetClassroom(org, classroom)

  // Inside a single assignment the nav is assignment-scoped: show assignment
  // actions (and a back link) instead of the classroom menu.
  if (org && classroom && assignment) {
    return (
      <>
        <ClassroomLogo />
        <ExpandSidebarButton />
        <AssignmentSidebarMenu
          org={org}
          classroom={classroom}
          assignment={assignment}
        />
        <SidebarFooter />
      </>
    )
  }

  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      {org && <AllClasses org={org} />}
      <SidebarClassInfo classInfo={classData} />
      {org && classroom && (
        <TeacherSidebarMenu
          selected={selected}
          org={org}
          classroom={classroom}
        />
      )}
      <SidebarFooter />
    </>
  )
}

export const MyClasses = ({ settings = false, selected = "" }) => {
  const { org } = useParams({ strict: false })
  const { t } = useTranslation()
  const { showTeacherUi, roleResolved } = useConfigRepoAccess(org)
  // Org-level Members/Settings are owner-only, so gate those two links on the
  // org-role capability rather than the broad staff signal.
  const { orgRole } = useOrgRole()
  const isOwner = can("manageOrg", { orgRole })
  const onSettings = settings || selected === "settings"
  const onPublished = selected === "published"
  const onMembers = selected === "members"
  const onActivity = selected === "activity"
  if (!org) return null

  const classesLabel = showTeacherUi
    ? t("nav.myClasses")
    : t("nav.myAssignments")

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        {!roleResolved ? (
          <li className="flex px-2 py-2">
            <span className="skeleton inline-block h-4 w-24 align-middle bg-neutral-content/10" />
          </li>
        ) : (
          <Tip label={classesLabel}>
            <Link to="/$org" params={{ org }}>
              <SidebarItemBody
                label={classesLabel}
                icon={<BookText aria-hidden="true" />}
                active={
                  !onSettings && !onPublished && !onMembers && !onActivity
                }
              />
            </Link>
          </Tip>
        )}
        {showTeacherUi && (
          <Tip label={t("nav.published")}>
            <Link to="/$org/published" params={{ org }}>
              <SidebarItemBody
                label={t("nav.published")}
                icon={<Globe aria-hidden="true" />}
                active={onPublished}
              />
            </Link>
          </Tip>
        )}
        {showTeacherUi && isOwner && (
          <Tip label={t("nav.members")}>
            <Link to="/$org/members" params={{ org }}>
              <SidebarItemBody
                label={t("nav.members")}
                icon={<UsersRound aria-hidden="true" />}
                active={onMembers}
              />
            </Link>
          </Tip>
        )}
        {showTeacherUi && isOwner && (
          <Tip label={t("nav.activity")}>
            <Link to="/$org/activity" params={{ org }}>
              <SidebarItemBody
                label={t("nav.activity")}
                icon={<Activity aria-hidden="true" />}
                active={onActivity}
              />
            </Link>
          </Tip>
        )}
        {showTeacherUi && isOwner && (
          <Tip label={t("nav.settings")}>
            <Link to="/$org/settings" params={{ org }}>
              <SidebarItemBody
                label={t("nav.settings")}
                icon={<Settings aria-hidden="true" />}
                active={onSettings}
              />
            </Link>
          </Tip>
        )}
      </ul>
    </div>
  )
}

export const MyOrgs = ({ settings = false }) => {
  const { t } = useTranslation()
  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <Tip label={t("nav.organizations")}>
          <Link to="/">
            <SidebarItemBody
              label={t("nav.organizations")}
              icon={<BookText aria-hidden="true" />}
              active={!settings}
            />
          </Link>
        </Tip>
      </ul>
    </div>
  )
}

export const SidebarContentClasses = ({
  selected,
  settings = false,
}: {
  selected: string
  settings?: boolean
}) => {
  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      <MyClasses selected={selected} settings={settings} />
      <SidebarFooter />
    </>
  )
}

export const SidebarContentOrgs = ({ selected }: { selected: string }) => {
  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      <MyOrgs settings={selected === "settings"} />
      <SidebarFooter />
    </>
  )
}

export default Drawer
