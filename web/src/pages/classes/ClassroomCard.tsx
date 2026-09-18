import { ConfirmModal } from "@/components/modals"
import {
  Badge,
  Card,
  Dropdown,
  DropdownMenu,
  EmphasisLtr,
  Heading,
  RouterButton,
} from "@/components/ui"
import { useToast } from "@/context/notifications/NotificationProvider"
import { GitHubAPIError } from "@/github-core/errors"
import { useArchiveClassroom } from "@/hooks/mutations/useArchiveClassroom"
import { useDeleteClassroom } from "@/hooks/mutations/useDeleteClassroom"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useStudentCount from "@/hooks/useStudentCount"
import {
  classroomDisplayName,
  type ClassroomSummary,
} from "@/hooks/useClassroomSummaries"
import { EnterDiv } from "@/lib/motionComponents"
import { classroomConfigTreeUrl } from "@/util/orgUrl"
import {
  ArchiveIcon,
  BookIcon,
  KebabHorizontalIcon,
  LinkExternalIcon,
  PencilIcon,
  PeopleIcon,
  TrashIcon,
} from "@/components/ui/icons"
import { useEffect, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { errorText } from "@/types/localizedMessage"

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
    isUnknown: studentsUnknown,
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
    // Settled but unknowable to this viewer (see useStudentCount.isUnknown):
    // the stat is omitted, neither a spinner nor "0 students".
    studentsUnknown,
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
// View on GitHub. The shared <Dropdown> owns the menu-button semantics
// (keyboard roving, Escape + outside-click close, focus return).
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
  const { notify, announce } = useToast()
  const [menuOpen, setMenuOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const slug = summary.path
  const name = classroomDisplayName(summary, t("classes.unknownClassName"))
  const archived = summary.archived

  // Hold the parent's list order frozen while this card is "busy" — the menu is
  // open OR a destructive confirm modal is open — so an async re-sort (e.g., a
  // roster resolving under the student-count sort) can't reshuffle the list out
  // from under an in-flight Archive/Delete. The menu closes before the modal
  // opens, so gating on the menu alone would release the freeze mid-flow.
  useEffect(() => {
    onMenuOpenChange?.(menuOpen || archiveOpen || deleteOpen)
  }, [menuOpen, archiveOpen, deleteOpen, onMenuOpenChange])

  const archiveMutation = useArchiveClassroom(org, slug)
  const deleteMutation = useDeleteClassroom(org, slug)

  return (
    <>
      <Dropdown align="end" onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger
          variant="ghost"
          size="sm"
          shape="circle"
          className="text-base-content/70 hover:text-primary"
          aria-label={t("classes.card.actionsAria", { name })}
          onClick={(e) => e.stopPropagation()}
        >
          <KebabHorizontalIcon aria-hidden="true" className="size-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu className="w-52">
          <DropdownMenu.RouterLinkItem
            icon={PencilIcon}
            label={t("classes.card.edit")}
            to="/$org/$classroom/settings"
            params={{ org, classroom: slug }}
          />
          <DropdownMenu.Item
            icon={ArchiveIcon}
            label={archived ? t("classes.unarchive") : t("classes.archive")}
            onSelect={() => setArchiveOpen(true)}
          />
          <DropdownMenu.LinkItem
            icon={LinkExternalIcon}
            label={t("classes.card.viewOnGitHub")}
            href={classroomConfigTreeUrl(org, slug)}
          />
          <DropdownMenu.Item
            icon={TrashIcon}
            label={t("classes.card.delete")}
            destructive
            onSelect={() => setDeleteOpen(true)}
          />
        </DropdownMenu>
      </Dropdown>

      <ConfirmModal
        open={archiveOpen}
        title={
          archived
            ? t("classes.unarchiveConfirmTitle")
            : t("classes.archiveConfirmTitle")
        }
        description={
          <Trans
            i18nKey={archived ? "classes.unarchiveBody" : "classes.archiveBody"}
            values={{ classroom: slug }}
            components={{
              classroom: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmLabel={archived ? t("classes.unarchive") : t("classes.archive")}
        cancelLabel={t("common.cancel")}
        needsConfirm={false}
        tone="warning"
        onConfirm={async () => {
          try {
            await archiveMutation.mutateAsync(archived, {
              onSuccess: (_r, active) => {
                // The badge flips in place — SR announcement only (Primer:
                // no visual success message for an evident outcome).
                announce(
                  active
                    ? t("classes.unarchivedToast", { classroom: slug })
                    : t("classes.archivedToast", { classroom: slug }),
                )
              },
            })
          } catch (err) {
            // Rethrow with the localized copy so the failure surfaces inside
            // the confirm dialog (Primer: dialog errors stay in the dialog).
            throw new Error(
              t(
                archived ? "classes.unarchiveFailed" : "classes.archiveFailed",
                {
                  classroom: slug,
                  error: errorText(t, err),
                },
              ),
              { cause: err },
            )
          }
        }}
        onClose={() => setArchiveOpen(false)}
      />

      <ConfirmModal
        open={deleteOpen}
        title={t("classes.deleteClassroomTitle")}
        description={
          <Trans
            i18nKey="classes.deleteClassroomBody"
            values={{ classroom: slug, org }}
            components={{
              classroom: <EmphasisLtr className="text-base-content" />,
              org: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmText={`${org}/${slug}`}
        confirmLabel={t("classes.deleteClassroomConfirm")}
        cancelLabel={t("classes.deleteClassroomCancel")}
        tone="error"
        warning={t("classes.deleteClassroomWarning")}
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync(
              { org, classroom: slug },
              {
                onSuccess: (result) => {
                  // deleteClassroom returns { deleted: false } as a no-op (e.g.
                  // the dir was already gone). Don't claim success in that case.
                  if (!result.deleted) {
                    notify({
                      tone: "warning",
                      message: t("classes.deleteNoop", { classroom: slug }),
                    })
                    return
                  }
                  // The list flow stays put (no navigate), so it is the natural
                  // place to surface the non-fatal team-cleanup warning that the
                  // edit page silently drops.
                  if (result.teamDeleteWarning) {
                    notify({
                      tone: "warning",
                      message: t("classes.deleteTeamWarning", {
                        classroom: slug,
                      }),
                    })
                  } else {
                    // The card disappears — SR announcement only.
                    announce(t("classes.deletedToast", { classroom: slug }))
                  }
                },
              },
            )
          } catch (err) {
            // Surfaces inside the confirm dialog rather than a corner toast.
            throw new Error(
              t("classes.deleteFailed", {
                classroom: slug,
                error: errorText(t, err),
              }),
              { cause: err },
            )
          }
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  )
}

function ClassroomBadges({ summary }: { summary: ClassroomSummary }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <Badge tone="primary" size="md">
        {summary.term || t("classes.noTermSpecified")}
      </Badge>
      {summary.archived && (
        // badge-neutral is deliberately not a Badge tone (Badge's neutral is
        // the uncolored chip), so the archived chip keeps its inline recipe.
        <span className="badge badge-soft badge-neutral">
          {t("classes.archived")}
        </span>
      )}
    </div>
  )
}

export function ClassroomStats({ org, slug }: { org: string; slug: string }) {
  const { t } = useTranslation()
  const {
    studentCount,
    studentsError,
    studentsUnknown,
    assignmentCount,
    assignmentsError,
  } = useCardCounts(org, slug)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {!studentsUnknown && (
        <CountStat
          icon={<PeopleIcon aria-hidden="true" className="size-4" />}
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
      )}
      <CountStat
        icon={<BookIcon aria-hidden="true" className="size-4" />}
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

function ViewRosterButton({
  org,
  slug,
  classroomName,
  block,
}: {
  org: string
  slug: string
  classroomName: string
  block?: boolean
}) {
  const { t } = useTranslation()
  return (
    <RouterButton
      to="/$org/$classroom/roster"
      params={{ org, classroom: slug }}
      aria-label={t("classes.viewRosterAria", {
        classroom: classroomName,
      })}
      variant="outline"
      size="sm"
      className={block ? "flex-1" : undefined}
    >
      {t("classes.viewRoster")}
    </RouterButton>
  )
}

function ViewAssignmentsButton({
  org,
  slug,
  classroomName,
  block,
}: {
  org: string
  slug: string
  classroomName: string
  block?: boolean
}) {
  const { t } = useTranslation()
  return (
    <RouterButton
      to="/$org/$classroom/assignments"
      params={{ org, classroom: slug }}
      aria-label={t("classes.viewAssignmentsAria", {
        classroom: classroomName,
      })}
      variant="outline"
      size="sm"
      className={block ? "flex-1" : undefined}
    >
      {t("classes.viewAssignments")}
    </RouterButton>
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
        <Heading as="h2" className="truncate">
          {name}
        </Heading>
        <ClassroomStats org={org} slug={summary.path} />
        {/* Side-by-side actions; each stretches (flex-1), so a student's
            single Assignments button still fills the row. Roster is
            staff-only (the route requires it), so students don't get a link
            into a denied page. */}
        <div className="flex gap-2">
          {canManage && (
            <ViewRosterButton
              org={org}
              slug={summary.path}
              classroomName={name}
              block
            />
          )}
          <ViewAssignmentsButton
            org={org}
            slug={summary.path}
            classroomName={name}
            block
          />
        </div>
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
    <EnterDiv className="col-span-12 flex flex-col gap-3 rounded-box border border-base-300 bg-base-200 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{name}</span>
          <ClassroomBadges summary={summary} />
        </div>
        <ClassroomStats org={org} slug={summary.path} />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {canManage && (
          <ViewRosterButton
            org={org}
            slug={summary.path}
            classroomName={name}
          />
        )}
        <ViewAssignmentsButton
          org={org}
          slug={summary.path}
          classroomName={name}
        />
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
