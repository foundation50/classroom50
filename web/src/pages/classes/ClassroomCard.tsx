import {
  deleteClassroom,
  editClassroomWithConflictRetry,
} from "@/domain/classrooms"
import { ConfirmModal } from "@/components/modals"
import { Button, Card } from "@/components/ui"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubAPIError } from "@/github-core/errors"
import type { GitHubFileListing } from "@/github-core/types"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useStudentCount from "@/hooks/useStudentCount"
import {
  classroomDisplayName,
  type ClassroomSummary,
} from "@/hooks/useClassroomSummaries"
import { EnterDiv } from "@/lib/motionComponents"
import { classroomConfigTreeUrl } from "@/util/orgUrl"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Archive,
  ArchiveRestore,
  BookText,
  ExternalLink,
  MoreVertical,
  Pencil,
  Trash2,
  UsersRound,
} from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

type ClassroomCardProps = {
  summary: ClassroomSummary
  org: string
  canManage: boolean
  // Notify the parent to hold list order stable while a card's menu is open, so
  // an async re-sort can't shift a different classroom under the open menu.
  onMenuOpenChange?: (open: boolean) => void
}

// Student + assignment counts for a single visible card. Reuses the shared
// roster/assignments caches. Assignment count coalesces to 0 (unlike students,
// useGetClassroomAssignments does not pre-default and 404s for a classroom with
// no assignments.json); a non-404 error sets assignmentsError so the caller can
// show "Counts unavailable".
function useCardCounts(org: string, classroom: string) {
  const {
    studentCount,
    isLoading: studentsLoading,
    isError: studentsError,
  } = useStudentCount(org, classroom)
  const assignmentsQuery = useGetClassroomAssignments(org, classroom)
  // A missing assignments.json 404s (a brand-new classroom has none), which is
  // the normal zero case — not a failure. Only a non-404 error is "unavailable".
  const assignmentsNotFound =
    assignmentsQuery.error instanceof GitHubAPIError &&
    assignmentsQuery.error.status === 404
  return {
    // undefined while the authoritative team count resolves; on error the caller
    // shows "counts unavailable" rather than a misleading 0 (R6).
    studentCount: studentsLoading ? undefined : studentCount,
    studentsError,
    // Optional-chain `assignments` too: jsonFileQuery does no shape validation,
    // so a file that parses without an `assignments` array must not throw.
    assignmentCount: assignmentsQuery.isPending
      ? undefined
      : (assignmentsQuery.data?.assignments?.length ?? 0),
    assignmentsError: assignmentsQuery.isError && !assignmentsNotFound,
  }
}

function CountStat({
  icon,
  loading,
  loadingLabel,
  label,
}: {
  icon: React.ReactNode
  loading: boolean
  loadingLabel: string
  label: string
}) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-base-content/70">
      {icon}
      {loading ? (
        <>
          <span
            className="skeleton skeleton-shimmer inline-block h-4 w-16 align-middle"
            aria-hidden="true"
          />
          <span className="sr-only">{loadingLabel}</span>
        </>
      ) : (
        label
      )}
    </span>
  )
}

// The kebab actions menu: Edit (link), Archive/Unarchive (inline, optimistic +
// rollback), Delete (type-to-confirm, stays on list, surfaces teamDeleteWarning),
// View on GitHub. Accessible menu semantics with Escape + outside-click close
// and focus return to the trigger.
function ClassroomMenu({
  summary,
  org,
  onMenuOpenChange,
}: {
  summary: ClassroomSummary
  org: string
  onMenuOpenChange?: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  const slug = summary.path
  const name = classroomDisplayName(summary, t("classes.unknownClassName"))
  const archived = summary.archived

  const menuRef = useRef<HTMLUListElement | null>(null)

  // Escape returns focus to the trigger; a plain close does not.
  const closeMenu = (returnFocus = false) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  // Hold the parent's list order frozen while this card is "busy" — the menu is
  // open OR a destructive confirm modal is open — so an async re-sort (e.g. a
  // roster resolving under the student-count sort) can't reshuffle the list out
  // from under an in-flight Archive/Delete. The menu closes before the modal
  // opens, so gating on the menu alone would release the freeze mid-flow.
  useEffect(() => {
    onMenuOpenChange?.(open || archiveOpen || deleteOpen)
  }, [open, archiveOpen, deleteOpen, onMenuOpenChange])

  // On open, move focus into the menu (first item), per the WAI-ARIA menu
  // button pattern.
  useEffect(() => {
    if (!open) return
    const first =
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
  }, [open])

  // Escape + outside-click close; Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu(true)
    }
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onClick)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onClick)
    }
  }, [open])

  // Arrow/Home/End roving between menu items (WAI-ARIA menu keyboard model).
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    let next: number
    switch (e.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : (current + 1) % items.length
        break
      case "ArrowUp":
        next = current <= 0 ? items.length - 1 : current - 1
        break
      case "Home":
        next = 0
        break
      case "End":
        next = items.length - 1
        break
      case "Tab":
        // Tabbing out closes the menu (focus leaves), matching native menus.
        setOpen(false)
        return
      default:
        return
    }
    e.preventDefault()
    items[next]?.focus()
  }

  const archiveMutation = useMutation({
    mutationFn: (active: boolean) =>
      editClassroomWithConflictRetry(client, { org, slug, active }),
    onMutate: (active: boolean) => {
      const key = githubKeys.jsonFile(
        org,
        CONFIG_REPO,
        `${slug}/classroom.json`,
      )
      const prev = queryClient.getQueryData(key)
      // Optimistically flip the cached active so the card repartitions at once.
      queryClient.setQueryData(
        key,
        (current: Record<string, unknown> | undefined) =>
          current ? { ...current, active } : current,
      )
      // Do NOT invalidate this exact key (GitHub contents is read-after-write
      // eventual). Repartition the list via the list-level key instead.
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
      return { key, prev }
    },
    onError: (err, _active, ctx) => {
      // Roll back the optimistic flip so a failed write can't strand the card
      // in the wrong tab.
      if (ctx) queryClient.setQueryData(ctx.key, ctx.prev)
      notify({
        tone: "error",
        message: t(
          archived ? "classes.unarchiveFailed" : "classes.archiveFailed",
          {
            classroom: slug,
            error:
              err instanceof Error
                ? err.message
                : t("classes.somethingWentWrong"),
          },
        ),
      })
    },
    onSuccess: (_r, active) => {
      notify({
        tone: "success",
        durationMs: 5000,
        message: active
          ? t("classes.unarchivedToast", { classroom: slug })
          : t("classes.archivedToast", { classroom: slug }),
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteClassroom(client, { org, classroom: slug }),
    onSuccess: (result) => {
      // deleteClassroom returns { deleted: false } as a no-op (e.g. the dir was
      // already gone). Don't claim success in that case.
      if (!result.deleted) {
        notify({
          tone: "warning",
          message: t("classes.deleteNoop", { classroom: slug }),
        })
        queryClient.invalidateQueries({
          queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
        })
        return
      }
      // Optimistically drop the dir from the cached listing so the card leaves
      // at once — the Contents API is read-after-write eventual, so an immediate
      // refetch can still return the just-deleted dir. Then invalidate to
      // reconcile.
      const listKey = githubKeys.jsonFile(org, CONFIG_REPO, "")
      queryClient.setQueryData(
        listKey,
        (prev: GitHubFileListing[] | undefined) =>
          prev ? prev.filter((entry) => entry.path !== slug) : prev,
      )
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
      // The list flow stays put (no navigate), so it is the natural place to
      // finally surface the non-fatal team-cleanup warning that the edit page
      // silently dropped.
      if (result.teamDeleteWarning) {
        notify({
          tone: "warning",
          message: t("classes.deleteTeamWarning", { classroom: slug }),
        })
      } else {
        notify({
          tone: "success",
          durationMs: 5000,
          message: t("classes.deletedToast", { classroom: slug }),
        })
      }
    },
    onError: (err) => {
      notify({
        tone: "error",
        message: t("classes.deleteFailed", {
          classroom: slug,
          error:
            err instanceof Error
              ? err.message
              : t("classes.somethingWentWrong"),
        }),
      })
    },
  })

  const menuItem =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200"

  return (
    <div ref={containerRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        shape="circle"
        className="text-base-content/70 hover:text-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("classes.card.actionsAria", { name })}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <MoreVertical aria-hidden="true" className="size-4" />
      </Button>

      {open && (
        <ul
          id={menuId}
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-box border border-base-300 bg-base-100 py-1 shadow-lg"
        >
          <li role="none">
            <Link
              role="menuitem"
              tabIndex={-1}
              to="/$org/$classroom/edit"
              params={{ org, classroom: slug }}
              className={menuItem}
              onClick={() => closeMenu()}
            >
              <Pencil aria-hidden="true" className="size-4" />
              {t("classes.card.edit")}
            </Link>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={menuItem}
              onClick={() => {
                closeMenu()
                setArchiveOpen(true)
              }}
            >
              {archived ? (
                <ArchiveRestore aria-hidden="true" className="size-4" />
              ) : (
                <Archive aria-hidden="true" className="size-4" />
              )}
              {archived ? t("classes.unarchive") : t("classes.archive")}
            </button>
          </li>
          <li role="none">
            <a
              role="menuitem"
              tabIndex={-1}
              href={classroomConfigTreeUrl(org, slug)}
              target="_blank"
              rel="noreferrer"
              className={menuItem}
              onClick={() => closeMenu()}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {t("classes.card.viewOnGitHub")}
            </a>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`${menuItem} text-error`}
              onClick={() => {
                closeMenu()
                setDeleteOpen(true)
              }}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              {t("classes.card.delete")}
            </button>
          </li>
        </ul>
      )}

      <ConfirmModal
        open={archiveOpen}
        title={
          archived
            ? t("classes.unarchiveConfirmTitle")
            : t("classes.archiveConfirmTitle")
        }
        description={
          archived ? (
            <>
              {t("classes.unarchiveBody_prefix")}{" "}
              <span className="font-semibold text-base-content">{slug}</span>{" "}
              {t("classes.unarchiveBody_suffix")}
            </>
          ) : (
            <>
              {t("classes.archiveBody_prefix")}{" "}
              <span className="font-semibold text-base-content">{slug}</span>
              {t("classes.archiveBody_suffix")}
            </>
          )
        }
        confirmLabel={archived ? t("classes.unarchive") : t("classes.archive")}
        cancelLabel={t("common.cancel")}
        needsConfirm={false}
        dangerous={false}
        onConfirm={async () => {
          await archiveMutation.mutateAsync(archived)
        }}
        onClose={() => setArchiveOpen(false)}
      />

      <ConfirmModal
        open={deleteOpen}
        title={t("classes.deleteClassroomTitle")}
        description={
          <>
            {t("classes.deleteClassroomBody_1")}{" "}
            <span className="font-semibold text-base-content">{slug}</span>{" "}
            {t("classes.deleteClassroomBody_2")}{" "}
            <span className="font-semibold text-base-content">{org}</span>{" "}
            {t("classes.deleteClassroomBody_3")}
          </>
        }
        confirmText={`${org}/${slug}`}
        confirmLabel={t("classes.deleteClassroomConfirm")}
        cancelLabel={t("classes.deleteClassroomCancel")}
        dangerous
        onConfirm={async () => {
          await deleteMutation.mutateAsync()
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  )
}

function ClassroomBadges({ summary }: { summary: ClassroomSummary }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span className="badge badge-soft badge-primary">
        {summary.term || t("classes.noTermSpecified")}
      </span>
      {summary.archived && (
        <span className="badge badge-soft badge-neutral">
          {t("classes.archived")}
        </span>
      )}
    </div>
  )
}

export function ClassroomStats({ org, slug }: { org: string; slug: string }) {
  const { t } = useTranslation()
  const { studentCount, studentsError, assignmentCount, assignmentsError } =
    useCardCounts(org, slug)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <CountStat
        icon={<UsersRound aria-hidden="true" className="size-4" />}
        loading={studentCount === undefined && !studentsError}
        loadingLabel={t("classes.card.loadingStudents")}
        label={
          studentsError
            ? t("classes.card.countsUnavailable")
            : studentCount === 0
              ? t("classes.noStudents")
              : t("classes.studentCount", { count: studentCount ?? 0 })
        }
      />
      <CountStat
        icon={<BookText aria-hidden="true" className="size-4" />}
        loading={assignmentCount === undefined && !assignmentsError}
        loadingLabel={t("classes.card.loadingAssignments")}
        label={
          assignmentsError
            ? t("classes.card.countsUnavailable")
            : assignmentCount === 0
              ? t("classes.card.noAssignments")
              : t("classes.card.assignmentCount", {
                  count: assignmentCount ?? 0,
                })
        }
      />
    </div>
  )
}

function ViewAssignmentsButton({
  org,
  slug,
  block,
}: {
  org: string
  slug: string
  block?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Link
      type="button"
      to="/$org/$classroom/assignments"
      params={{ org, classroom: slug }}
      className={`btn btn-outline btn-primary btn-sm ${block ? "w-full" : ""}`}
    >
      <BookText aria-hidden="true" className="size-4" />
      {t("classes.viewAssignments")}
    </Link>
  )
}

export function ClassroomCard({
  summary,
  org,
  canManage,
  onMenuOpenChange,
}: ClassroomCardProps) {
  const { t } = useTranslation()
  const name = classroomDisplayName(summary, t("classes.unknownClassName"))

  return (
    <Card
      as={EnterDiv}
      radius="xl"
      shadow={false}
      className="col-span-12 md:col-span-6 xl:col-span-4"
    >
      <Card.Body className="gap-4">
        <div className="flex items-start justify-between gap-2">
          <ClassroomBadges summary={summary} />
          {canManage && (
            <ClassroomMenu
              summary={summary}
              org={org}
              onMenuOpenChange={onMenuOpenChange}
            />
          )}
        </div>
        <h2 className="truncate text-xl font-semibold">{name}</h2>
        <ClassroomStats org={org} slug={summary.path} />
        <ViewAssignmentsButton org={org} slug={summary.path} block />
      </Card.Body>
    </Card>
  )
}

export function ClassroomRow({
  summary,
  org,
  canManage,
  onMenuOpenChange,
}: ClassroomCardProps) {
  const { t } = useTranslation()
  const name = classroomDisplayName(summary, t("classes.unknownClassName"))

  return (
    <EnterDiv className="col-span-12 flex flex-col gap-3 rounded-xl border border-base-300 bg-base-100 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{name}</span>
          <ClassroomBadges summary={summary} />
        </div>
        <ClassroomStats org={org} slug={summary.path} />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <ViewAssignmentsButton org={org} slug={summary.path} />
        {canManage && (
          <ClassroomMenu
            summary={summary}
            org={org}
            onMenuOpenChange={onMenuOpenChange}
          />
        )}
      </div>
    </EnterDiv>
  )
}
