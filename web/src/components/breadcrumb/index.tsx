import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react"

import useGetClassroom from "@/hooks/useGetClassroom"
import useGetClasses from "@/hooks/useGetClasses"
import useClassroomSummaries, {
  classroomDisplayName,
} from "@/hooks/useClassroomSummaries"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import { useDismissOnOutsidePointerDown } from "@/hooks/useDismissOnOutsidePointerDown"
import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import {
  Button,
  cx,
  Input,
  InlineMessage,
  popoverPanelClass,
} from "@/components/ui"
import { CheckIcon, TriangleDownIcon, SearchIcon } from "@/components/ui/icons"
import { GitHubAPIError } from "@/github-core/errors"

// GitHub-style leaf switcher (like the repo picker in github.com's header):
// the current segment's name in default ink plus a caret that opens a titled
// quick-switch panel — search field on top, filtered destinations below. It
// replaces a redundant static leaf ("Assignments" on the assignments page,
// "Submissions" on the submissions page).
//
// Open state is explicit React state, not daisyUI's focus-driven `dropdown`:
// a search input inside a blur-to-close popover fights its own focus handling
// (see Combobox for the same constraint).
const CrumbSwitcher = <T,>({
  name,
  title,
  searchPlaceholder,
  items,
  getLabel,
  loadError = false,
  children,
}: {
  name: ReactNode
  // Visible panel heading and the trigger's accessible name ("Switch
  // classroom" / "Switch assignment"), so what the menu switches between is
  // explicit.
  title: string
  searchPlaceholder: string
  items: T[]
  // Plain-text form of an item, used for search filtering.
  getLabel: (item: T) => string
  // The source list failed to load (a real failure, not the expected
  // role-based 404): the panel says so instead of showing an empty list a
  // user would misread as "nothing to switch to".
  loadError?: boolean
  // Renders the filtered items as menu rows; `close` dismisses the panel on
  // selection.
  children: (visible: T[], close: () => void) => ReactNode
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null)
  const panelId = useId()

  const close = useCallback(() => setOpen(false), [])
  useDismissOnOutsidePointerDown(wrapperRef, open, close)

  // Escape dismisses from anywhere (search field or a focused row) and hands
  // focus back to the trigger. Document-level because a listener on the panel
  // div itself would make it a non-interactive element with handlers.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, close])

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? items.filter((item) => getLabel(item).toLowerCase().includes(needle))
    : items

  return (
    // cursor-default + hover:no-underline: daisyUI's breadcrumbs styles any
    // direct li child as a link (pointer + hover underline), but this leaf is
    // the current page, not a destination.
    <span className="inline-flex cursor-default items-center gap-1 hover:no-underline">
      {name}
      <div ref={wrapperRef} className="relative">
        <Button
          ref={triggerRef}
          variant="ghost"
          size="xs"
          shape="square"
          aria-label={title}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            setQuery("")
            setOpen((wasOpen) => !wasOpen)
          }}
        >
          <TriangleDownIcon aria-hidden="true" className="size-4" />
        </Button>
        {open && (
          <div
            id={panelId}
            // A titled popup with focusable content is a dialog; autoFocus on
            // the search field moves focus in, Escape returns it.
            role="dialog"
            aria-label={title}
            className={cx(
              "absolute start-0 top-full w-64 whitespace-normal",
              popoverPanelClass,
            )}
          >
            <div className="border-b border-base-300 px-3 py-2 text-sm font-semibold text-base-content">
              {title}
            </div>
            <div className="border-b border-base-300 p-2">
              <Input
                inputSize="sm"
                autoFocus
                leadingIcon={
                  <SearchIcon
                    aria-hidden="true"
                    className="size-4 text-base-content/60"
                  />
                }
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {loadError ? (
              <InlineMessage tone="error" className="px-3 py-3">
                {t("components.breadcrumb.loadError")}
              </InlineMessage>
            ) : visible.length > 0 ? (
              // text-base-content: rows are actions, not trail links, so they
              // opt out of the nav's [&_a] accent-blue. The --menu-active-*
              // vars tone daisyUI's pressed-item feedback down from the
              // theme's near-black neutral surface to the same subtle wash as
              // hover — an inverted flash mid-navigation reads as a glitch
              // here.
              <ul className="menu max-h-72 w-full flex-nowrap overflow-y-auto p-1 [--menu-active-fg:var(--color-base-content)] [--menu-active-bg:color-mix(in_oklab,var(--color-base-content)_10%,transparent)] [&_a]:text-base-content">
                {children(visible, close)}
              </ul>
            ) : (
              <div className="px-3 py-3 text-sm text-base-content/70">
                {t("components.breadcrumb.noMatches")}
              </div>
            )}
          </div>
        )}
      </div>
    </span>
  )
}

const Breadcrumb = ({
  className,
  endpoint,
  assignmentName,
  switcher,
}: {
  className?: string
  // Static label for the current-page leaf. Omit when `switcher` promotes the
  // classroom/assignment segment itself to the leaf.
  endpoint?: string
  // Resolved display name for the $assignment segment (falls back to the
  // slug). Passed by the page because the metadata source is role-aware
  // (private config repo for staff, public Pages for students) — the
  // breadcrumb can't pick the right transport itself.
  assignmentName?: string
  // Renders that segment as the current-page leaf with a quick-switch
  // dropdown instead of a link followed by a static `endpoint`.
  switcher?: "classroom" | "assignment"
}) => {
  const { org, classroom, assignment } = useParams({ strict: false })
  const { data: classData } = useGetClassroom(org, classroom)
  const { t } = useTranslation()

  // Switcher menu data. Each source stays idle (disabled query / empty list)
  // unless its switcher is requested. Both read the staff config repo, so for
  // a student the list resolves empty and the leaf degrades to plain text.
  const { classes, isError: classesError } = useGetClasses(
    switcher === "classroom" ? org : undefined,
  )
  const classroomSummaries = useClassroomSummaries(org, classes)
  const assignmentsQuery = useGetClassroomAssignments(org, classroom, {
    enabled: switcher === "assignment",
  })
  // A student's 404 on the staff-only assignments.json is the expected
  // degrade-to-plain-text path, not a load failure.
  const assignmentsError =
    assignmentsQuery.isError &&
    !(
      assignmentsQuery.error instanceof GitHubAPIError &&
      assignmentsQuery.error.status === 404
    )

  if (!org && !classroom) return <div></div>

  const classroomName = classData?.name || classData?.short_name || classroom
  // Archived classrooms are parked, not in rotation, so they stay out of the
  // quick switcher — except the one currently being viewed.
  const switchableClassrooms = classroomSummaries.filter(
    (s) => !s.archived || s.path === classroom,
  )
  const assignments = assignmentsQuery.data?.assignments ?? []

  return (
    // Primer-style trail: no surface of its own — accent-blue links with the
    // current page in default ink, sitting directly on the canvas.
    <nav
      aria-label={t("components.breadcrumb.label")}
      className={cx(
        "breadcrumbs text-sm [&_a]:text-[var(--color-link)]",
        // The switcher panel paints outside the trail, and daisyUI's
        // `breadcrumbs` horizontal scroll container would clip it.
        switcher && "overflow-visible",
        className,
      )}
    >
      <ol>
        {org && (
          <li>
            <Link to="/$org" params={{ org }}>
              {t("components.breadcrumb.classes")}
            </Link>
          </li>
        )}
        {org && classroom && switcher === "classroom" && (
          <li aria-current="page">
            {switchableClassrooms.length > 1 || classesError ? (
              <CrumbSwitcher
                name={classroomName}
                title={t("components.breadcrumb.switchClassroom")}
                searchPlaceholder={t("components.breadcrumb.findClassroom")}
                items={switchableClassrooms}
                getLabel={(s) => classroomDisplayName(s, s.path)}
                loadError={classesError}
              >
                {(visible, close) =>
                  visible.map((s) => (
                    <li key={s.path}>
                      <Link
                        to="/$org/$classroom"
                        params={{ org, classroom: s.path }}
                        className="flex items-center justify-between gap-2"
                        aria-current={s.path === classroom ? "page" : undefined}
                        onClick={close}
                      >
                        {classroomDisplayName(s, s.path)}
                        {s.path === classroom && (
                          <CheckIcon
                            className="size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        )}
                      </Link>
                    </li>
                  ))
                }
              </CrumbSwitcher>
            ) : (
              classroomName
            )}
          </li>
        )}
        {org && classroom && switcher !== "classroom" && (
          <li>
            <Link to="/$org/$classroom" params={{ org, classroom }}>
              {classroomName}
            </Link>
          </li>
        )}
        {org && classroom && assignment && (
          <>
            <li>
              <Link
                to="/$org/$classroom/assignments"
                params={{ org, classroom }}
              >
                {t("components.breadcrumb.assignments")}
              </Link>
            </li>
            {switcher === "assignment" ? (
              <li aria-current="page">
                {assignments.length > 1 || assignmentsError ? (
                  <CrumbSwitcher
                    name={assignmentName || assignment}
                    title={t("components.breadcrumb.switchAssignment")}
                    searchPlaceholder={t(
                      "components.breadcrumb.findAssignment",
                    )}
                    items={assignments}
                    getLabel={(a) => a.name || a.slug}
                    loadError={assignmentsError}
                  >
                    {/* Straight to each assignment's submissions gradebook:
                        the switcher only materializes from the staff-only
                        assignments.json, so no role fork is needed. */}
                    {(visible, close) =>
                      visible.map((a) => (
                        <li key={a.slug}>
                          <Link
                            to="/$org/$classroom/assignments/$assignment/submissions"
                            params={{ org, classroom, assignment: a.slug }}
                            className="flex items-center justify-between gap-2"
                            aria-current={
                              a.slug === assignment ? "page" : undefined
                            }
                            onClick={close}
                          >
                            {a.name || a.slug}
                            {a.slug === assignment && (
                              <CheckIcon
                                className="size-4 shrink-0 text-primary"
                                aria-hidden="true"
                              />
                            )}
                          </Link>
                        </li>
                      ))
                    }
                  </CrumbSwitcher>
                ) : (
                  assignmentName || assignment
                )}
              </li>
            ) : (
              <li>
                <Link
                  to="/$org/$classroom/assignments/$assignment"
                  params={{ org, classroom, assignment }}
                >
                  {assignmentName || assignment}
                </Link>
              </li>
            )}
          </>
        )}
        {endpoint && <li aria-current="page">{endpoint}</li>}
      </ol>
    </nav>
  )
}

export default Breadcrumb
