import { useNavigate } from "@tanstack/react-router"
import { EmptyState } from "@/components/list"
import { Trans, useTranslation } from "react-i18next"
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  LinkIcon,
  LockIcon,
  PencilIcon,
  ShieldCheckIcon,
  TrashIcon,
  UnlockIcon,
} from "@/components/ui/icons"

import useGetScores from "@/hooks/useGetScores"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { acceptLinkUrl } from "@/util/acceptLink"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { existingGroupRepos } from "@/pages/submissions/dashboard"
import { isNoAutograderAssignment } from "@/domain/assignments/autogradingState"
import { formatDueDate, formatDueDateTime, isPastDue } from "@/util/formatDate"
import { composedRepoNameFits } from "@/util/repoNameBudget"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
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
import { ClickableTr } from "@/lib/motionComponents"
import { blockEnter } from "@/lib/motion"
import { motion } from "motion/react"
import type { AssignmentSort } from "@/pages/assignments/assignmentList"
import {
  DueDateCell,
  ModeBadge,
} from "@/components/assignments/AssignmentCells"
import {
  Badge,
  Button,
  EmphasisLtr,
  MetricCount,
  MetricBar,
  SkeletonRows,
  SortableTh,
  TableShell,
} from "@/components/ui"

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
        className="text-base-content/60 hover:text-error focus-visible:text-error"
        aria-label={t("assignments.table.deleteAria", {
          name: assignment.name || assignment.slug,
        })}
      >
        <TrashIcon className="size-4" aria-hidden="true" />
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

// Per-row "Copy accept link" — reaching the same link through the submissions
// page's share modal costs four clicks per assignment (issue #731). Copying
// mutates nothing, so it stays on archived and TA rows too.
//
// Disabled while the classroom read is unresolved — still loading, or failed:
// either way `secret` is undefined, indistinguishable from "unprotected", and
// copying a protected classroom's link without its `?k=` would hand students a
// silent 404.
const CopyAcceptLinkButton = ({
  org,
  classroom,
  assignment,
  secret,
  secretPending = false,
}: {
  org: string
  classroom: string
  assignment: Assignment
  secret?: string
  secretPending?: boolean
}) => {
  const { t } = useTranslation()
  const { copied, copy } = useCopyToClipboard(
    acceptLinkUrl(org, classroom, assignment.slug, secret),
    1500,
  )

  return (
    <Button
      variant="ghost"
      size="sm"
      shape="circle"
      disabled={secretPending}
      title={
        secretPending
          ? t("assignments.table.copyLinkPending")
          : copied
            ? t("assignments.table.linkCopied")
            : t("assignments.table.copyLinkTitle")
      }
      aria-label={t("assignments.table.copyLinkAria", {
        name: name(assignment),
      })}
      onClick={(e) => {
        e.stopPropagation()
        void copy()
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-4 text-success" />
      ) : (
        <LinkIcon aria-hidden="true" className="size-4" />
      )}
    </Button>
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
        <CopyIcon aria-hidden="true" className="size-4" />
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
        <ShieldCheckIcon aria-hidden="true" className="size-4" />
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
          <UnlockIcon aria-hidden="true" className="size-4" />
        ) : (
          <LockIcon aria-hidden="true" className="size-4" />
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

// The Release Date cell. Dates are data, not status, so a passed (released)
// date renders as plain text like the Due date column; only the scheduled
// state keeps a warning badge, because the assignment is hidden from students'
// lists until then (link-only accept), which the tooltip explains. "Not set"
// is the common link-only default, so it stays muted.
const ReleaseDateCell = ({ assignment }: { assignment: Assignment }) => {
  const { t } = useTranslation()
  const releasesAt = assignment.available_from
  if (!releasesAt) {
    return (
      <span
        className="whitespace-nowrap text-base-content/60 max-xl:text-xs xl:text-sm"
        title={t("assignments.table.linkOnlyTitle")}
      >
        {t("assignments.table.releaseNotSet")}
      </span>
    )
  }
  if (isPastDue(releasesAt)) {
    return (
      <span
        className="whitespace-nowrap max-xl:text-xs xl:text-sm"
        title={formatDueDateTime(releasesAt)}
      >
        {formatDueDate(releasesAt)}
      </span>
    )
  }
  return (
    <Badge
      tone="warning"
      className="whitespace-nowrap"
      title={t("assignments.table.linkOnlyTitle")}
    >
      {t("assignments.table.scheduled", {
        date: formatDueDateTime(releasesAt),
      })}
    </Badge>
  )
}

const SKELETON_BARS = [
  "h-4 w-40",
  "h-4 w-24",
  "h-6 w-28",
  "h-6 w-28",
  "h-4 w-32",
  "h-4 w-32",
  "ms-auto h-8 w-16",
]

const AssignmentsTable = ({
  org,
  classroom,
  secret,
  secretPending,
  assignments,
  allAssignments,
  studentCount,
  loading = false,
  archived = false,
  canAuthor = false,
  sort,
  onSortChange,
  viewSignature = "",
}: {
  org: string
  classroom: string
  // The classroom's capability-URL secret (classroom.json `secret`), read off
  // the same classroom.json the page already loads for `archived`. Threaded in
  // so each row's copied accept link carries `?k=` for a protected classroom;
  // undefined for the unprotected default — and indistinguishable from "not
  // loaded yet", which is what `secretPending` separates.
  secret?: string
  // Whether that classroom read is unresolved (in flight or failed), so the copy
  // action waits rather than hand out a keyless link for a protected classroom.
  secretPending?: boolean
  assignments?: Assignment[]
  // The UNFILTERED assignment list, for the sibling-slug repo-attribution
  // guard. `assignments` is the visible (searched/filtered) set — deriving
  // siblings from it would drop a hidden slug-extending sibling and
  // mis-attribute its repos. Falls back to `assignments` when omitted.
  allAssignments?: Assignment[]
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
  // Column-header sorting (Assignment toggles name asc/desc, Due date toggles
  // due asc/desc), sharing the toolbar select's sort state. Omitted, headers
  // render as static text.
  sort?: AssignmentSort
  onSortChange?: (sort: AssignmentSort) => void
  // A signature of the current view (filter/sort — NOT the search text, which
  // changes per keystroke and would remount the rows mid-typing). Keys the row
  // container so the rows replay their entrance when the view changes.
  viewSignature?: string
}) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: scoresData } = useGetScores(org, classroom)
  // Org repo list, for the group-row denominator (accepted groups = group
  // repos that exist). Shared react-query cache with the submissions page.
  const { data: orgRepos } = useGetOrgRepos(org)
  // Sibling slugs guard group-repo attribution against a slug-extending
  // sibling ("hw1-bonus" under "hw1") — derived from the full list so a
  // filtered-out sibling still guards; see existingGroupRepos.
  const siblingSlugs = (allAssignments ?? assignments)?.map((a) => a.slug) ?? []
  // Raw funnel counts for one row, shared by the Accepted and Submitted cells.
  //
  // `submitted`: an assignment that skips grading records no autograded
  // `entries`, so its count comes from the bucket's `detected` list —
  // commits/tags collect_scores.py observed in the student repos. Only
  // no_autograder is detected; a bare empty_repo has no submission definition,
  // so it keeps the entries-based count rather than waiting for a `detected`
  // list no writer produces. And a teacher can hand-grade a no_autograder
  // assignment, which DOES write entries — so take whichever signal credits
  // more owners instead of letting an empty detection hide real grades (#659).
  //
  // `notCollected`: a `detected` key that is absent (not `[]`) means no
  // collect has walked the bucket yet, which is NOT "nobody submitted".
  //
  // `accepted`: this assignment's existing repos, reverse-parsed from the org
  // repo list — individual student repos and group repos share the
  // <classroom>-<slug>-<owner> name shape, so one parse serves both modes.
  // undefined while the repo list is still loading.
  const funnelCounts = (assignment: Assignment) => {
    const graded = scoresData?.submissions?.[assignment.slug]?.length ?? 0
    const detectedRows = isNoAutograderAssignment(assignment)
      ? scoresData?.detected?.[assignment.slug]
      : undefined
    const notCollected =
      isNoAutograderAssignment(assignment) && !detectedRows && graded === 0
    const submitted = Math.max(graded, detectedRows?.length ?? 0)
    const accepted = orgRepos
      ? existingGroupRepos(orgRepos, classroom, assignment.slug, siblingSlugs)
          .length
      : undefined
    return { submitted, accepted, notCollected }
  }
  const navigate = useNavigate()
  // Mutating row actions require both an unarchived classroom and author rights.
  const canMutate = !archived && canAuthor

  return (
    // The shell's own entrance is off: the page-level PageTransition already
    // animates navigation, and the tbody blockEnter below is the data-arrival
    // cue — a third nested entrance reads as a double pop.
    <TableShell animate={false} padded ariaBusy={loading}>
      <caption className="sr-only">{t("assignments.table.caption")}</caption>
      <thead>
        <tr>
          <SortableTh
            label={t("assignments.table.colAssignment")}
            sort={sort}
            asc="name-asc"
            desc="name-desc"
            onSortChange={onSortChange}
            title={t("assignments.table.sortByName")}
          />
          <th scope="col">{t("assignments.table.colType")}</th>
          <th scope="col">{t("assignments.table.colReleaseDate")}</th>
          <SortableTh
            label={t("assignments.table.colDueDate")}
            sort={sort}
            asc="due-asc"
            desc="due-desc"
            onSortChange={onSortChange}
            title={t("assignments.table.sortByDue")}
          />
          <th scope="col">{t("assignments.table.colAccepted")}</th>
          <th scope="col">{t("assignments.table.colSubmitted")}</th>
          <th scope="col">
            <span className="sr-only">{t("assignments.table.colActions")}</span>
          </th>
        </tr>
      </thead>
      {/* Same recipe as the submissions table: the body enters as one block
            (blockEnter) and replays when the view changes (data arrival, filter,
            sort — not per search keystroke, which the signature excludes). */}
      <motion.tbody
        key={`${loading}:${viewSignature}`}
        variants={blockEnter}
        initial="initial"
        animate="animate"
      >
        {loading && <SkeletonRows bars={SKELETON_BARS} />}
        {!loading && !assignments?.length && (
          <tr>
            <td colSpan={7}>
              <EmptyState variant="bare" body={t("assignments.table.empty")} />
            </td>
          </tr>
        )}
        {!loading &&
          assignments?.map((assignment) => (
            <ClickableTr key={assignment.slug} className="hover:bg-base-200">
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
                    <LockIcon aria-hidden="true" className="size-3" />
                    {t("assignments.table.lockedBadge")}
                  </Badge>
                )}
                {!composedRepoNameFits(classroom, assignment.slug).fits && (
                  // Over the composed repo-name budget (#691): some usernames
                  // can't accept. Links to the settings page, where the
                  // eligibility-gated rename remediation lives.
                  <Link
                    to="/$org/$classroom/assignments/$assignment/settings"
                    params={{ org, classroom, assignment: assignment.slug }}
                    onClick={(event) => event.stopPropagation()}
                    className="mt-1 block w-fit"
                    title={t("assignments.table.overBudgetBadgeTitle")}
                  >
                    <Badge
                      tone="error"
                      size="sm"
                      className="gap-1 whitespace-nowrap"
                    >
                      <AlertIcon aria-hidden="true" className="size-3" />
                      {t("assignments.table.overBudgetBadge")}
                    </Badge>
                  </Link>
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
                <ModeBadge mode={assignment.mode} />
              </td>
              <td
                onClick={() =>
                  navigate({
                    to: "/$org/$classroom/assignments/$assignment/submissions",
                    params: { org, classroom, assignment: assignment.slug },
                  })
                }
              >
                <ReleaseDateCell assignment={assignment} />
              </td>
              <td
                onClick={() =>
                  navigate({
                    to: "/$org/$classroom/assignments/$assignment/submissions",
                    params: { org, classroom, assignment: assignment.slug },
                  })
                }
              >
                <DueDateCell due={assignment.due} />
              </td>
              {/* The funnel cells deep-link to the actionable cohort: who
                    hasn't accepted / hasn't submitted. Groups have no
                    acceptance filter (no roster denominator), so their
                    Accepted cell opens the dashboard unfiltered. */}
              <td
                onClick={() =>
                  navigate({
                    to: "/$org/$classroom/assignments/$assignment/submissions",
                    params: { org, classroom, assignment: assignment.slug },
                    search:
                      assignment.mode === "group"
                        ? undefined
                        : { status: "not-accepted" },
                  })
                }
              >
                {(() => {
                  const { submitted, accepted } = funnelCounts(assignment)
                  if (accepted === undefined) {
                    // Org repo list still loading — no acceptance signal yet.
                    return <span className="text-base-content/60">—</span>
                  }
                  if (assignment.mode === "group") {
                    // A group assignment nobody has started has no repos and
                    // therefore no denominator to measure — a bare "0" would
                    // imply one. Muted empty state + tooltip instead.
                    if (accepted === 0) {
                      return (
                        <span
                          className="inline-block w-28 whitespace-nowrap text-center text-base-content/60"
                          title={t("assignments.table.noGroupsYetTitle")}
                        >
                          {t("assignments.table.noGroupsYet")}
                        </span>
                      )
                    }
                    // Groups have no roster denominator (any student can
                    // found one), so acceptance is a bare count — no bar;
                    // the "groups" context lives in the tooltip.
                    return (
                      <MetricCount
                        value={accepted}
                        tone="info"
                        title={t("assignments.table.groupsAcceptedTitle")}
                      />
                    )
                  }
                  const total = studentCount ?? 0
                  // Clamp (KTD4-style): a staff/extra repo could push the
                  // count past the student-role total, and a recorded
                  // submission implies its repo existed.
                  const shown = Math.min(
                    Math.max(accepted, Math.min(submitted, total)),
                    total,
                  )
                  return (
                    <MetricBar
                      value={shown}
                      max={total}
                      tone="info"
                      title={t("assignments.table.acceptedTitle", {
                        accepted: shown,
                        total,
                      })}
                    />
                  )
                })()}
              </td>
              <td
                onClick={() =>
                  navigate({
                    to: "/$org/$classroom/assignments/$assignment/submissions",
                    params: { org, classroom, assignment: assignment.slug },
                    search: { status: "not-submitted" },
                  })
                }
              >
                {(() => {
                  const { submitted, accepted, notCollected } =
                    funnelCounts(assignment)
                  if (notCollected) {
                    return (
                      <span className="whitespace-nowrap text-base-content/60">
                        {t("assignments.table.notCollectedYet")}
                      </span>
                    )
                  }
                  if (assignment.mode === "group") {
                    // Groups submit per-repo, so the only meaningful
                    // denominator is the number of groups that accepted.
                    // Until the repo list loads, fall back to the bare count
                    // rather than a false "N / 0".
                    if (accepted === undefined) {
                      return (
                        <span className="whitespace-nowrap">
                          {t("assignments.table.groupsSubmitted", {
                            count: submitted,
                          })}
                        </span>
                      )
                    }
                    // No groups yet: nothing to measure against — mirror the
                    // Accepted cell's empty state instead of a false "0 / 0".
                    if (accepted === 0) {
                      return (
                        <span
                          className="inline-block w-28 text-center text-base-content/60"
                          title={t("assignments.table.noGroupsYetTitle")}
                        >
                          —
                        </span>
                      )
                    }
                    const shown = Math.min(submitted, accepted)
                    return (
                      <MetricBar
                        value={shown}
                        max={accepted}
                        tone="success"
                        title={t("assignments.table.submittedTitleGroup", {
                          submitted: shown,
                          accepted,
                        })}
                      />
                    )
                  }
                  // Denominator is the authoritative student-role count, not
                  // the roster row count (which includes staff). The
                  // numerator is a repo-count from scores.json with no role
                  // join, so a submission from a non-student repo could push
                  // it past the denominator — clamp the displayed fraction
                  // and the bar to 100% (KTD4). undefined count reads as 0
                  // until it resolves.
                  const total = studentCount ?? 0
                  const shown = Math.min(submitted, total)
                  return (
                    <MetricBar
                      value={shown}
                      max={total}
                      tone="success"
                      title={t("assignments.table.submittedTitle", {
                        submitted: shown,
                        total,
                      })}
                    />
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
                    <PencilIcon aria-hidden="true" className="size-4" />
                  ) : (
                    <EyeIcon aria-hidden="true" className="size-4" />
                  )}
                </Link>
                {/* Read-only actions, so they survive the archived /
                    can't-author gate below: copying a link mutates nothing, and
                    reviewing template access (or reaching the source repo)
                    stays available because the modal owner-gates its re-grant.
                    TemplateAccessButton renders nothing without a template. */}
                <CopyAcceptLinkButton
                  org={org}
                  classroom={classroom}
                  assignment={assignment}
                  secret={secret}
                  secretPending={secretPending}
                />
                <TemplateAccessButton
                  org={org}
                  classroom={classroom}
                  assignment={assignment}
                />
                {canMutate && (
                  <>
                    <ReuseAssignmentButton
                      org={org}
                      classroom={classroom}
                      assignment={assignment}
                    />
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
            </ClickableTr>
          ))}
      </motion.tbody>
    </TableShell>
  )
}

export default AssignmentsTable
