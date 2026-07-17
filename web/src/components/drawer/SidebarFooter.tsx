import {
  LogOut,
  Eye,
  Check,
  Sun,
  Moon,
  Languages,
  Info,
  BookOpen,
} from "lucide-react"
import {
  useParams,
  useMatchRoute,
  useMatch,
  useNavigate,
} from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { useEffect, useId, useRef, useState } from "react"
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
        ${collapsed ? "start-2 w-48" : "start-6 end-6"}
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
                <span className="flex-1 text-start">
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
                <span className="flex-1 text-start">{t("nav.language")}</span>
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
                <span className="flex-1 text-start">{t("nav.docs")}</span>
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
                <span className="flex-1 text-start">{t("nav.about")}</span>
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
          className={`flex w-full items-center gap-2.5 text-start ${collapsed ? "justify-center" : "justify-start"}`}
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
