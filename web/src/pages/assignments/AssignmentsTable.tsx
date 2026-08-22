import { useNavigate } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import {
  Copy,
  Eye,
  Lock,
  LockOpen,
  Pencil,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react"

import useGetScores from "@/hooks/useGetScores"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { assignmentSkipsGrading } from "@/domain/assignments/autogradingState"
import { assignmentRepoCount } from "@/domain/assignments/assignmentRepoPresence"
import { formatDueDate, formatDueDateTime, isPastDue } from "@/util/formatDate"
import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { ConfirmModal } from "@/components/modals"
import { ReuseAssignmentModal } from "@/components/modals/ReuseAssignmentModal"
import { TemplateAccessModal } from "@/components/modals/TemplateAccessModal"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { useQueryClient } from "@tanstack/react-query"
import { useDeleteAssignment } from "@/hooks/mutations/useDeleteAssignment"
import { useSetAssignmentLock } from "@/hooks/mutations/useSetAssignmentLock"
import { useToast } from "@/context/notifications/NotificationProvider"
import type { Assignment } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Badge, Button, EmphasisLtr, SkeletonCell } from "@/components/ui"

const DeleteAssignmentButton = ({
  org,
  classroom,
  assignment,
  onDeleteAssignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
  onDeleteAssignment: () => void
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const deleteAssignmentMutation = useDeleteAssignment()

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="text-error"
        aria-label={t("assignments.table.deleteAria", {
          name: assignment.name || assignment.slug,
        })}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>

      <ConfirmModal
        open={open}
        title={t("assignments.table.deleteTitle")}
        description={
          <Trans
            i18nKey="assignments.table.deleteDescription"
            values={{
              assignment: assignment.name || assignment.slug,
              classroom: `${org}/${classroom}`,
            }}
            components={{
              assignment: <EmphasisLtr className="text-base-content" />,
              classroom: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmText={assignment.slug}
        confirmLabel={t("assignments.table.deleteConfirm")}
        cancelLabel={t("assignments.table.deleteCancel")}
        dangerous
        onConfirm={async () => {
          await deleteAssignmentMutation.mutateAsync({
            org,
            classroom,
            assignment: assignment.slug,
          })
          onDeleteAssignment()
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

const ReuseAssignmentButton = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title={t("assignments.table.reuseTitle")}
        aria-label={t("assignments.table.reuseAria")}
      >
        <Copy aria-hidden="true" className="size-4" />
      </Button>

      {open ? (
        <ReuseAssignmentModal
          org={org}
          classroom={classroom}
          assignment={assignment}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

// Per-row "Template access": opens a modal to review which template repo the
// assignment uses and which GitHub teams can read it, and (org owners only)
// re-grant the classroom student/TA teams read — the acceptance-blocking fix
// from issue #305. Merges the former source-repo link and fix-access button.
const TemplateAccessButton = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!assignment.template) return null

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        title={t("assignments.template.accessModal.triggerTitle")}
        aria-label={t("assignments.template.accessModal.triggerAria", {
          name: assignment.name || assignment.slug,
        })}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <ShieldCheck aria-hidden="true" className="size-4" />
      </Button>
      {open ? (
        <TemplateAccessModal
          org={org}
          classroom={classroom}
          assignment={assignment}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

// Per-row Lock/Unlock action. Locking closes the assignment to every student
// (accept + submission surfaces refuse it) and, for a private in-org template,
// removes the student team's read on it; unlocking reverses both. The template
// side effect can partly fail without failing the flag flip, so a non-fatal
// templateAccessWarning surfaces as a warning toast.
const LockAssignmentButton = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const [open, setOpen] = useState(false)
  const locked = Boolean(assignment.locked)
  const label = name(assignment)
  // The lock-vs-unlock label set, chosen once so the JSX below reads one field
  // each instead of repeating the `locked ? … : …` branch at every attribute.
  const copy = locked
    ? {
        title: t("assignments.table.unlockTitle"),
        aria: t("assignments.table.unlockAria", { name: label }),
        modalTitle: t("assignments.table.unlockTitleModal"),
        descriptionKey: "assignments.table.unlockDescription",
        confirm: t("assignments.table.unlockConfirm"),
      }
    : {
        title: t("assignments.table.lockTitle"),
        aria: t("assignments.table.lockAria", { name: label }),
        modalTitle: t("assignments.table.lockTitleModal"),
        descriptionKey: "assignments.table.lockDescription",
        confirm: t("assignments.table.lockConfirm"),
      }
  const setLock = useSetAssignmentLock(org, classroom, (result) => {
    if (result.templateAccessWarning) {
      notify({ tone: "warning", message: result.templateAccessWarning })
      return
    }
    notify({
      tone: "success",
      message: result.locked
        ? t("assignments.table.lockSuccess", { name: label })
        : t("assignments.table.unlockSuccess", { name: label }),
    })
  })

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        className={locked ? "text-warning" : undefined}
        title={copy.title}
        aria-label={copy.aria}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        {locked ? (
          <LockOpen aria-hidden="true" className="size-4" />
        ) : (
          <Lock aria-hidden="true" className="size-4" />
        )}
      </Button>

      <ConfirmModal
        open={open}
        title={copy.modalTitle}
        description={
          <Trans
            i18nKey={copy.descriptionKey}
            values={{ assignment: label }}
            components={{
              assignment: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmLabel={copy.confirm}
        cancelLabel={t("assignments.table.lockCancel")}
        dangerous={!locked}
        needsConfirm={false}
        onConfirm={async () => {
          await setLock.mutateAsync({
            org,
            classroom,
            slug: assignment.slug,
            locked: !locked,
          })
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

// Assignment display name with a slug fallback, shared by the row action labels.
const name = (assignment: Assignment): string =>
  assignment.name || assignment.slug

// The Release Date cell. A released assignment (date set and passed) shows the
// date in a neutral badge like Due date; an unreleased one is warning-toned
// because it's hidden from students' lists until then (link-only accept),
// which the tooltip explains. "Not set" is the common link-only default.
const ReleaseDateBadge = ({ assignment }: { assignment: Assignment }) => {
  const { t } = useTranslation()
  const releasesAt = assignment.available_from
  const released = releasesAt ? isPastDue(releasesAt) : false
  return (
    <Badge
      tone={released ? "neutral" : "warning"}
      size="md"
      className="max-xl:text-xs xl:text-sm whitespace-nowrap w-full"
      title={released ? undefined : t("assignments.table.linkOnlyTitle")}
    >
      {releasesAt
        ? released
          ? formatDueDate(releasesAt)
          : t("assignments.table.scheduled", {
              date: formatDueDateTime(releasesAt),
            })
        : t("assignments.table.releaseNotSet")}
    </Badge>
  )
}

const SkeletonRows = ({ rows = 4 }: { rows?: number }) => (
  <>
    {Array.from({ length: rows }).map((_, i) => (
      // Decorative loading placeholder — hidden from assistive tech so a screen
      // reader announces the table's busy state, not rows of empty cells.
      <tr key={i} aria-hidden="true">
        <SkeletonCell bar="h-4 w-40" />
        <SkeletonCell bar="h-4 w-24" />
        <SkeletonCell bar="h-6 w-28" />
        <SkeletonCell bar="h-6 w-28" />
        <SkeletonCell bar="h-4 w-56" />
        <SkeletonCell bar="ms-auto h-8 w-16" />
      </tr>
    ))}
  </>
)

const AssignmentsTable = ({
  org,
  classroom,
  assignments,
  studentCount,
  loading = false,
  archived = false,
  canAuthor = false,
}: {
  org: string
  classroom: string
  assignments?: Assignment[]
  // Authoritative student-role count (from useStudentCount), the denominator for
  // the submission ratio. undefined while the count is still resolving.
  studentCount?: number
  loading?: boolean
  // When archived, hide per-row mutating actions (edit/reuse/delete); viewing
  // stays available.
  archived?: boolean
  // Whether the viewer can author assignments (teacher|hta). A TA sees the list
  // read-only: the pencil becomes a view icon and reuse/delete are hidden, same
  // shape as the archived case. GitHub also 403s a TA's config-repo write, so
  // this is the UX guard, not the enforcer.
  canAuthor?: boolean
}) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: scoresData } = useGetScores(org, classroom)
  // Assignments that never autograde have a permanently empty scores.json
  // bucket (collect_scores.py skips them), so the "N / M submitted" fraction
  // would read 0/M no matter what students did (#659). Those rows show a
  // repo-presence affordance instead, derived from the org repo list.
  const needsRepoPresence = useMemo(
    () => (assignments ?? []).some((a) => assignmentSkipsGrading(a)),
    [assignments],
  )
  // One whole-org read for the entire table, and only when a row actually needs
  // it — never a per-row fan-out. React Query shares it (same key, 60s stale)
  // with the submissions page, so opening an assignment doesn't re-paginate.
  const { data: orgRepos, isPending: orgReposPending } = useGetOrgRepos(
    org,
    needsRepoPresence,
  )
  // Sibling slugs guard a repo whose assignment slug extends another's
  // (`hw1-bonus` counting as `hw1`) — see existingAssignmentRepos.
  const allSlugs = useMemo(
    () => (assignments ?? []).map((assignment) => assignment.slug),
    [assignments],
  )
  const navigate = useNavigate()
  // Mutating row actions require both an unarchived classroom and author rights.
  const canMutate = !archived && canAuthor

  return (
    <EnterDiv
      key={loading ? "loading" : "loaded"}
      className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100"
    >
      <table className="table" aria-busy={loading}>
        <caption className="sr-only">{t("assignments.table.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("assignments.table.colAssignment")}</th>
            <th scope="col">{t("assignments.table.colType")}</th>
            <th scope="col">{t("assignments.table.colReleaseDate")}</th>
            <th scope="col">{t("assignments.table.colDueDate")}</th>
            <th scope="col">{t("assignments.table.colSubmissions")}</th>
            <th scope="col">
              <span className="sr-only">
                {t("assignments.table.colActions")}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && <SkeletonRows />}
          {!loading && !assignments?.length && (
            <tr>
              <td colSpan={6} className="text-center">
                {t("assignments.table.empty")}
              </td>
            </tr>
          )}
          {!loading &&
            assignments?.map((assignment) => (
              <tr
                key={assignment.slug}
                className="hover:cursor-pointer hover:bg-base-200"
              >
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                  className="truncate"
                >
                  {/* Real link (not a click-only div) so the row's primary
                      action is keyboard-reachable and exposes a link role; the
                      td onClick stays as a mouse convenience. */}
                  <Link
                    to="/$org/$classroom/assignments/$assignment/submissions"
                    params={{ org, classroom, assignment: assignment.slug }}
                    aria-label={t("assignments.table.openSubmissionsAria", {
                      name: name(assignment),
                    })}
                    className="font-bold link link-info no-underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {assignment.name}
                  </Link>
                  <div className="font-mono text-xs text-base-content/70">
                    {assignment.slug}
                  </div>
                  {assignment.locked && (
                    <Badge
                      tone="warning"
                      size="sm"
                      className="mt-1 gap-1 whitespace-nowrap"
                      title={t("assignments.table.lockedBadgeTitle")}
                    >
                      <Lock aria-hidden="true" className="size-3" />
                      {t("assignments.table.lockedBadge")}
                    </Badge>
                  )}
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                  className="max-xl:text-xs"
                >
                  {assignment.mode === "individual" && (
                    <div className="flex gap-2 h-full">
                      <UserRound className="max-xl:size-3" aria-hidden="true" />{" "}
                      {t("assignments.table.individual")}
                    </div>
                  )}
                  {assignment.mode === "group" && (
                    <div className="flex gap-2 h-full">
                      <UsersRound
                        className="max-xl:size-3"
                        aria-hidden="true"
                      />{" "}
                      {t("assignments.table.group")}
                    </div>
                  )}
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                >
                  <ReleaseDateBadge assignment={assignment} />
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                >
                  <Badge
                    tone="neutral"
                    size="md"
                    className="max-xl:text-xs xl:text-sm whitespace-nowrap w-full"
                  >
                    {assignment.due
                      ? formatDueDate(assignment.due)
                      : t("assignments.table.noDueDate")}
                  </Badge>
                </td>
                <td
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments/$assignment/submissions",
                      params: { org, classroom, assignment: assignment.slug },
                    })
                  }
                >
                  {(() => {
                    // No collected scores will ever exist for an assignment that
                    // skips grading, so a fraction here would be a permanent
                    // 0/M (#659). Report what the org repo list can honestly
                    // support — whether repos exist — and send the teacher to
                    // the submissions page, which owns the real submission
                    // count via commit/tag detection. Deliberately NOT a
                    // submitted count: repo presence is set at accept time, so
                    // counting it as submissions would contradict that page.
                    if (assignmentSkipsGrading(assignment)) {
                      if (orgReposPending) {
                        return (
                          <span
                            aria-hidden="true"
                            className="skeleton skeleton-shimmer inline-block h-4 w-40 align-middle"
                          />
                        )
                      }
                      const repos = assignmentRepoCount(
                        orgRepos,
                        classroom,
                        assignment.slug,
                        allSlugs,
                      )
                      return (
                        <span className="whitespace-nowrap">
                          {repos > 0
                            ? t("assignments.table.reposAccepted", {
                                count: repos,
                              })
                            : t("assignments.table.noReposYet")}
                        </span>
                      )
                    }

                    const submitted =
                      scoresData?.submissions?.[assignment.slug]?.length || 0

                    // Group assignments submit per-repo, not per-student, so a
                    // roster denominator is meaningless — show the count.
                    if (assignment.mode === "group") {
                      return (
                        <span className="whitespace-nowrap">
                          {t("assignments.table.groupsSubmitted", {
                            count: submitted,
                          })}
                        </span>
                      )
                    }

                    // Denominator is the authoritative student-role count, not
                    // the roster row count (which includes staff). The
                    // numerator is a repo-count from scores.json with no role
                    // join, so a submission from a non-student repo could push
                    // it past the denominator — clamp the displayed fraction and
                    // the bar to 100% (KTD4). undefined count reads as 0 until it
                    // resolves.
                    const denominator = studentCount ?? 0
                    const shown = Math.min(submitted, denominator)
                    return (
                      <>
                        {shown} / {denominator}{" "}
                        <progress
                          className="progress progress-info w-56"
                          value={
                            denominator === 0 ? 0 : (shown / denominator) * 100
                          }
                          max="100"
                        ></progress>
                      </>
                    )
                  })()}
                </td>
                <td>
                  <Link
                    className="btn btn-circle btn-sm btn-ghost"
                    to="/$org/$classroom/assignments/$assignment/settings"
                    params={{
                      org,
                      classroom,
                      assignment: assignment.slug,
                    }}
                    title={
                      canMutate
                        ? t("assignments.table.editAssignment")
                        : t("assignments.table.viewAssignment")
                    }
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                  >
                    {canMutate ? (
                      <Pencil aria-hidden="true" className="size-4" />
                    ) : (
                      <Eye aria-hidden="true" className="size-4" />
                    )}
                  </Link>
                  {!canMutate ? (
                    // Read-only rows (archived, or viewer can't author): reviewing
                    // template access (and reaching the source repo) stays
                    // available; the modal itself owner-gates the re-grant.
                    assignment.template && (
                      <TemplateAccessButton
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                      />
                    )
                  ) : (
                    <>
                      <ReuseAssignmentButton
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                      />
                      {assignment.template && (
                        <TemplateAccessButton
                          org={org}
                          classroom={classroom}
                          assignment={assignment}
                        />
                      )}
                      <LockAssignmentButton
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                      />
                      <DeleteAssignmentButton
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                        onDeleteAssignment={() =>
                          queryClient.invalidateQueries({
                            queryKey: githubKeys.jsonFile(
                              org,
                              CONFIG_REPO,
                              `${classroom}/assignments.json`,
                            ),
                          })
                        }
                      />
                    </>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </EnterDiv>
  )
}

export default AssignmentsTable
