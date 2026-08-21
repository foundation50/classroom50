import {
  LogOut,
  Eye,
  Check,
  Sun,
  Moon,
  Languages,
  Info,
  BookOpen,
  Accessibility,
} from "lucide-react"
import {
  useParams,
  useMatchRoute,
  useMatch,
  useNavigate,
  Link,
} from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { type MouseEvent, useId, useRef, useState } from "react"
import { useDismissOnOutsidePointerDown } from "@/hooks/useDismissOnOutsidePointerDown"
import { useGithubAuth } from "@/auth/useGithubAuth"
import GitHub from "@/assets/github.svg?react"
import duck from "@/assets/duck.png"
import { useOrgStaff } from "@/hooks/useOrgStaff"
import { useClassroomRoleContextOptional } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { can, roleLabelKey, type ViewAsRole } from "@/authz"
import { orgFooterRoleLabel } from "./footerRoleLabel"
import { useRoleView } from "@/context/roleView/RoleViewProvider"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useTheme } from "@/hooks/useTheme"
import { LanguageDialog } from "@/components/LanguageDialog"
import { AboutDialog } from "@/components/AboutDialog"
import { githubOrgUrl } from "@/util/orgUrl"
import { WIKI_URL } from "@/version"
import { useSidebarCollapse } from "./collapseContext"
import { DeployEnvBadge } from "./DeployEnvBadge"

// Presentational theme-toggle switch: plain <span>s (never a form <input>), so
// it can't be a focusable control nested inside the theme <button> (which would
// re-introduce the axe nested-interactive violation). DaisyUI's `.toggle` keys
// its knob/track off `input:checked`, which a non-input can't set, so the on/off
// look is hand-rolled here from `on`. The button owns state via aria-pressed;
// this is aria-hidden decoration. Exported for a focused unit test.

// A thin, non-interactive rule between menu groups. DaisyUI's `.divider` is a
// flex helper with its own min-height and heavy color, which renders as a stray
// dark bar inside a compact `.menu`; a bordered spacer is the clean separator.
const MenuSeparator = () => (
  <li
    aria-hidden="true"
    className="pointer-events-none my-1 border-t border-base-content/20"
  />
)

export const ThemeToggleTrack = ({ on }: { on: boolean }) => (
  <span
    aria-hidden="true"
    data-testid="theme-toggle-track"
    className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
      on ? "bg-primary" : "bg-base-content/30"
    }`}
  >
    <span
      data-testid="theme-toggle-knob"
      className={`size-4 rounded-full bg-base-100 shadow transition-transform ${
        on ? "translate-x-4 rtl:-translate-x-4" : ""
      }`}
    />
  </span>
)

// The account footer picks an auth-aware variant: signed-in users get the full
// account menu (role, View-as, sign-out) below; signed-out visitors get a
// minimal footer with no GitHub-client hooks (so it renders on public pages
// like /accessibility without a client or org-role providers).
export const SidebarFooter = () => {
  const { status } = useGithubAuth()
  return status === "authenticated" ? (
    <AuthedSidebarFooter />
  ) : (
    <PublicSidebarFooter />
  )
}

// The info controls both footers share as `<li>` rows, so the two footers never
// hand-sync a second copy. Ordered by intent: preferences (theme, language),
// then help/reference (accessibility, docs), then the least-used info (about).
// The caller supplies the pieces that legitimately differ: `onActivate` closes
// the authed account menu after a click (the public footer has no menu to
// close), `collapsed` drives the rail tooltips, and `showAccessibility` hides
// the Accessibility row on the /accessibility page itself.
function SidebarInfoControls({
  isDark,
  toggleTheme,
  onOpenLanguage,
  onOpenAbout,
  collapsed = false,
  showAccessibility = true,
  onActivate,
}: {
  isDark: boolean
  toggleTheme: () => void
  onOpenLanguage: () => void
  onOpenAbout: () => void
  collapsed?: boolean
  showAccessibility?: boolean
  onActivate?: () => void
}) {
  const { t } = useTranslation()
  // The authed account menu stops row clicks from bubbling to its close-on-
  // outside-pointerdown handler and then closes itself; the public footer needs
  // neither, so both collapse to this single guarded activation.
  const activate = (run: () => void) => (event: MouseEvent) => {
    if (onActivate) event.stopPropagation()
    run()
    onActivate?.()
  }
  return (
    <>
      <li>
        <button
          type="button"
          onClick={activate(toggleTheme)}
          aria-pressed={isDark}
          title={
            collapsed ? t(isDark ? "nav.darkMode" : "nav.lightMode") : undefined
          }
        >
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
          onClick={activate(onOpenLanguage)}
          title={collapsed ? t("nav.language") : undefined}
        >
          <Languages aria-hidden="true" className="size-4" />
          {!collapsed && (
            <span className="flex-1 text-start">{t("nav.language")}</span>
          )}
        </button>
      </li>
      {showAccessibility && (
        <li>
          <Link to="/accessibility" onClick={activate(() => {})}>
            <Accessibility aria-hidden="true" className="size-4" />
            {!collapsed && (
              <span className="flex-1 text-start">
                {t("nav.accessibility")}
              </span>
            )}
          </Link>
        </li>
      )}
      <li>
        <a
          href={WIKI_URL}
          target="_blank"
          rel="noreferrer"
          onClick={activate(() => {})}
          title={collapsed ? t("nav.docs") : undefined}
        >
          <BookOpen aria-hidden="true" className="size-4" />
          {!collapsed && (
            <span className="flex-1 text-start">{t("nav.docs")}</span>
          )}
        </a>
      </li>
      <li>
        <button
          type="button"
          onClick={activate(onOpenAbout)}
          title={collapsed ? t("nav.about") : undefined}
        >
          <Info aria-hidden="true" className="size-4" />
          {!collapsed && (
            <span className="flex-1 text-start">{t("nav.about")}</span>
          )}
        </button>
      </li>
    </>
  )
}

// The signed-out footer: the shared info controls plus (implicitly) nothing
// auth-gated — no avatar/role/View-as/sign-out and, crucially, none of the
// GitHub-client hooks the authed footer calls.
function PublicSidebarFooter() {
  const { collapsed } = useSidebarCollapse()
  const { isDark, toggleTheme } = useTheme()
  const langDialogRef = useRef<HTMLDialogElement | null>(null)
  const langDialogTitleId = useId()
  const aboutDialogRef = useRef<HTMLDialogElement | null>(null)
  const aboutDialogTitleId = useId()

  return (
    <div className="mt-auto border-t border-neutral-content/20 py-2">
      <ul className="menu w-full gap-1">
        <SidebarInfoControls
          isDark={isDark}
          toggleTheme={toggleTheme}
          onOpenLanguage={() => langDialogRef.current?.showModal()}
          onOpenAbout={() => aboutDialogRef.current?.showModal()}
          collapsed={collapsed}
        />
      </ul>

      {createPortal(
        <>
          <LanguageDialog ref={langDialogRef} titleId={langDialogTitleId} />
          <AboutDialog ref={aboutDialogRef} titleId={aboutDialogTitleId} />
        </>,
        document.body,
      )}
    </div>
  )
}

const AuthedSidebarFooter = () => {
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
  const { isNonStaff, isLoading: roleLoading } = useOrgStaff(org)
  // Org plan for the About-dialog diagnostics snapshot. Cached and shared with
  // the setup/audit panes; `plan` is only visible to org owners, so this is
  // often undefined (the snapshot then reports "unknown" with a reason).
  const { data: orgPlanDetails } = useGetOrgPlanDetails(org)
  // Precise classroom role (Teacher vs TA); respects the "view as" preview.
  // `actualRole` is the real (preview-independent) role. Null off a classroom
  // route (no provider), where the org-level label logic below applies instead.
  const classroomCtx = useClassroomRoleContextOptional()
  const classroomRole = classroomCtx?.role ?? "unresolved"
  const actualClassroomRole = classroomCtx?.actualRole ?? "unresolved"
  const classroomRoleLoading = classroomCtx?.isLoading ?? false
  const { viewAs, setViewAs } = useRoleView()
  // Offer "View as" only to a real teacher of THIS classroom — the role with
  // something lower to preview. Keyed off teacher-team membership, not
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
      to: "/$org/$classroom/assignments/$assignment/settings",
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
  // Org-owner signal for org-level routes (no classroom); see orgFooterRoleLabel
  // for the labeling rule.
  const {
    isOwner,
    isPending: ownerPending,
    isError: ownerError,
  } = useIsOrgOwner()

  // Role label per product mapping (owner shows as Teacher). On a classroom
  // route use the precise role; org-level routes delegate to the pure helper.
  let roleLabelText: string | null
  let labelPending: boolean
  if (classroom) {
    const key = classroomRoleLoading ? null : roleLabelKey(classroomRole)
    roleLabelText = key ? t(key) : null
    labelPending = classroomRoleLoading
  } else {
    const orgLabel = orgFooterRoleLabel({
      hasOrg: Boolean(org),
      isOrgSetup,
      isOwner,
      ownerPending,
      ownerError,
      isNonStaff,
      roleLoading,
    })
    roleLabelText = orgLabel.labelKey ? t(orgLabel.labelKey) : null
    labelPending = orgLabel.pending
  }

  const [menuOpen, setMenuOpen] = useState(false)
  const footerRef = useRef<HTMLDivElement | null>(null)
  const langDialogRef = useRef<HTMLDialogElement | null>(null)
  const langDialogTitleId = useId()
  const aboutDialogRef = useRef<HTMLDialogElement | null>(null)
  const aboutDialogTitleId = useId()
  const { collapsed } = useSidebarCollapse()
  const { isDark, toggleTheme } = useTheme()

  useDismissOnOutsidePointerDown(footerRef, menuOpen, () => setMenuOpen(false))

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
        className={`relative border-t border-neutral-content/20 ${collapsed ? "!px-2" : "!px-0"} ${org ? "" : "mt-auto"}`}
      >
        <div
          className={`
        absolute bottom-full z-50 mb-3
        ${collapsed ? "start-2 w-48" : "start-6 end-6"}
        origin-bottom rounded-box
        transition-all duration-150 ease-out

        ${
          menuOpen
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-2 scale-95 opacity-0"
        }
      `}
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
                      {(["self", "hta", "ta", "student"] as const).map(
                        (option) => {
                          const active =
                            option === "self"
                              ? viewAs === null
                              : viewAs === option
                          const label =
                            option === "self"
                              ? t("nav.viewAsMyself", {
                                  role: (() => {
                                    const key =
                                      roleLabelKey(actualClassroomRole)
                                    return key
                                      ? t(key)
                                      : t("nav.viewAsMyselfFallback")
                                  })(),
                                })
                              : option === "hta"
                                ? t("nav.viewAsHeadTa")
                                : option === "ta"
                                  ? t("nav.viewAsTA")
                                  : t("nav.viewAsStudent")
                          return (
                            <li key={option}>
                              <button
                                type="button"
                                className={active ? "active font-semibold" : ""}
                                onClick={() => {
                                  selectViewAs(
                                    option === "self" ? null : option,
                                  )
                                  setMenuOpen(false)
                                }}
                              >
                                {active ? (
                                  <Check
                                    aria-hidden="true"
                                    className="size-4"
                                  />
                                ) : (
                                  <span className="size-4" />
                                )}
                                {label}
                              </button>
                            </li>
                          )
                        },
                      )}
                    </ul>
                  </details>
                </li>
                <MenuSeparator />
              </>
            )}
            <SidebarInfoControls
              isDark={isDark}
              toggleTheme={toggleTheme}
              onOpenLanguage={() => langDialogRef.current?.showModal()}
              onOpenAbout={() => aboutDialogRef.current?.showModal()}
              onActivate={() => setMenuOpen(false)}
            />
            <MenuSeparator />
            <li>
              <button type="button" className="text-error" onClick={signOut}>
                <LogOut aria-hidden="true" className="size-4" />
                {t("nav.signOut")}
              </button>
            </li>
          </ul>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            // Native <button> handles Enter/Space; Escape-to-close is not native.
            if (event.key === "Escape") setMenuOpen(false)
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("nav.accountMenu")}
          className={`flex w-full cursor-pointer items-center gap-2.5 py-3 text-start transition-colors hover:bg-[var(--sidebar-surface)]/60 ${collapsed ? "flex-col justify-center px-2" : "justify-start px-6"}`}
          title={collapsed ? name : undefined}
        >
          <div className="avatar avatar-placeholder">
            <img
              src={avatar_img}
              alt={t("nav.avatarAlt", { name })}
              className={`rounded-full ${collapsed ? "w-7" : "w-8"}`}
            />
          </div>

          {collapsed && <DeployEnvBadge />}

          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-neutral-content">
                {name}
              </div>

              {org ? (
                <div className="mt-1 flex items-center gap-1.5">
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
                  <DeployEnvBadge />
                </div>
              ) : (
                // No role row off an org route — still surface the env badge.
                <div className="mt-1 flex items-center gap-1.5">
                  <DeployEnvBadge />
                </div>
              )}
            </div>
          )}
        </button>
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
