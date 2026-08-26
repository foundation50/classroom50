import { useState, type ReactNode } from "react"
import { selectAllState } from "@/util/rowSelection"
import { useNavigate } from "@tanstack/react-router"
import { EmptyState } from "@/components/list"
import { useTranslation } from "react-i18next"
import {
  AlertIcon,
  EyeIcon,
  LockIcon,
  PencilIcon,
  SlidersIcon,
} from "@/components/ui/icons"

import useGetScores from "@/hooks/useGetScores"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { existingGroupRepos } from "@/pages/submissions/dashboard"
import { isNoAutograderAssignment } from "@/domain/assignments/autogradingState"
import { formatDueDate, formatDueDateTime, isPastDue } from "@/util/formatDate"
import { composedRepoNameFits } from "@/util/repoNameBudget"
import { Link } from "@tanstack/react-router"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { useQueryClient } from "@tanstack/react-query"
import {
  assignmentName as name,
  CloneSubmissionsAction,
  CopyAcceptLinkAction,
  LockAssignmentAction,
} from "@/pages/assignments/AssignmentRowActions"
import { ManageAssignmentModal } from "@/pages/assignments/ManageAssignmentModal"
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
  MetricCount,
  MetricBar,
  SkeletonRows,
  SortableTh,
  TableShell,
} from "@/components/ui"

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

// Data columns excluding the selection checkbox: assignment, type, release,
// due, accepted, submitted, actions. Kept as one constant so the head's
// takeover colSpan and the empty row's colSpan can't drift apart.
const DATA_COLUMNS = 7

// Stable empty set so selectAllState isn't handed a fresh one each render.
const EMPTY_SELECTION: ReadonlySet<string> = new Set()
// Stable empty list for the views with no checkbox column, so select-all state
// isn't derived from a fresh array each render.
const EMPTY_ROWS: Assignment[] = []

const AssignmentsTable = ({
  org,
  classroom,
  secret,
  secretPending,
  assignments,
  allAssignments,
  empty,
  studentCount,
  loading = false,
  archived = false,
  canAuthor = false,
  selectedSlugs,
  onToggleRow,
  onToggleSelectAll,
  onRowCheckboxClick,
  bulkActions,
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
  // What the empty row renders when there is nothing to show. The page passes
  // its no-results panel here when a live selection keeps the table mounted
  // over a filtered-to-zero view — same panel, same Clear filters button as
  // when it replaces the table outright. Defaults to the "nothing created yet"
  // state, which would be a false statement about a merely filtered view.
  empty?: ReactNode
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
  // Bulk selection, owned by the page. Absent (undefined) turns the whole
  // column off — a read-only viewer has no bulk action to reach.
  selectedSlugs?: ReadonlySet<string>
  onToggleRow?: (slug: string) => void
  // Shift-click fills the range; see useRangeSelection for why this is a
  // separate onClick and not read off the change event.
  onRowCheckboxClick?: (
    event: React.MouseEvent<HTMLInputElement>,
    slug: string,
  ) => void
  onToggleSelectAll?: () => void
  // Rendered in the head row beside the select-all box once something is
  // selected, replacing the column titles — one row owns the selection, its
  // count, and what can be done with it.
  bulkActions?: ReactNode
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
  // The column renders only when the page handed in selection state; a viewer
  // who cannot author has no bulk action to reach, so it stays off for them.
  const selectable = Boolean(selectedSlugs && onToggleRow && onToggleSelectAll)
  // The header box describes the VIEW ("is everything I can see ticked"),
  // through the same helper the roster and members tables use.
  const { allSelected, someSelected } = selectAllState(
    selectable ? (assignments ?? []) : EMPTY_ROWS,
    selectedSlugs ?? EMPTY_SELECTION,
    (a) => a.slug,
  )
  // The takeover follows the SELECTION, not the view: a row hidden by the
  // search is still selected and still acted on, so the row that says so — and
  // offers Clear selection — must not vanish with it.
  const hasSelection = selectable && (selectedSlugs?.size ?? 0) > 0
  // The row whose assignment hub (ManageAssignmentModal) is open. Stored as a
  // slug and re-resolved against the live list on every render, so the hub
  // reflects a lock flip after assignments.json refetches and unmounts itself
  // when the assignment is deleted.
  const [manageSlug, setManageSlug] = useState<string | null>(null)
  const manageAssignment = manageSlug
    ? (assignments?.find((a) => a.slug === manageSlug) ?? null)
    : null
  const invalidateAssignments = () =>
    queryClient.invalidateQueries({
      queryKey: githubKeys.jsonFile(
        org,
        CONFIG_REPO,
        `${classroom}/assignments.json`,
      ),
    })

  return (
    <>
      {/* The shell's own entrance is off: the page-level PageTransition already
        animates navigation, and the tbody blockEnter below is the data-arrival
        cue — a third nested entrance reads as a double pop. */}
      <TableShell animate={false} padded ariaBusy={loading}>
        <caption className="sr-only">{t("assignments.table.caption")}</caption>
        <thead>
          <tr>
            {selectable && (
              // w-0 for the same reason as the actions column: a fixed-width
              // control must not be handed the table's surplus width.
              <th scope="col" className="w-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm align-middle"
                  aria-label={t("assignments.bulk.selectAll")}
                  // Nothing in view to select or deselect — a live selection
                  // from outside the filter is the bar's business, not this
                  // box's, so it would otherwise sit unchecked and inert.
                  disabled={!assignments?.length}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected
                  }}
                  onChange={onToggleSelectAll}
                />
              </th>
            )}
            {/* Selection takes over the REST of the head row — the checkbox
                above stays put, so there is exactly one select-all control
                either way. The column titles say nothing useful while the
                question is "what do I do with these four?".
                normal-case/font-normal because the head cell's own type
                styling is for column titles and would otherwise reshape the
                buttons sitting in it. */}
            {hasSelection ? (
              <th
                scope="col"
                colSpan={DATA_COLUMNS}
                className="py-2 font-normal normal-case"
              >
                {bulkActions}
              </th>
            ) : (
              <>
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
                {/* w-0: auto table layout hands surplus width to every column,
                    which stretched this fixed-width button strip. Zero width
                    makes the browser fall back to min-content here and give
                    the slack to the text columns instead. */}
                <th scope="col" className="w-0">
                  <span className="sr-only">
                    {t("assignments.table.colActions")}
                  </span>
                </th>
              </>
            )}
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
              <td colSpan={selectable ? DATA_COLUMNS + 1 : DATA_COLUMNS}>
                {empty ?? (
                  <EmptyState
                    variant="bare"
                    body={t("assignments.table.empty")}
                  />
                )}
              </td>
            </tr>
          )}
          {!loading &&
            assignments?.map((assignment) => (
              <ClickableTr key={assignment.slug} className="hover:bg-base-200">
                {selectable && (
                  <td
                    className="w-0"
                    // The row navigates on click; the checkbox cell must not,
                    // or ticking a box would leave the page.
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm size-6 align-middle"
                      aria-label={t("assignments.bulk.selectRow", {
                        assignment: name(assignment),
                      })}
                      checked={selectedSlugs?.has(assignment.slug) ?? false}
                      onClick={(event) =>
                        onRowCheckboxClick?.(event, assignment.slug)
                      }
                      onChange={() => onToggleRow?.(assignment.slug)}
                    />
                  </td>
                )}
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
                <td className="w-0 py-2! ps-2">
                  <div className="flex items-center justify-end gap-1">
                    {/* Quick-access shortcuts (accept link, clone CLI, edit,
                      lock); everything else lives in the assignment hub
                      behind the Manage trigger. The read-only shortcuts
                      survive the archived / can't-author gate: copying a link
                      or a clone command mutates nothing. */}
                    <CopyAcceptLinkAction
                      org={org}
                      classroom={classroom}
                      assignment={assignment}
                      secret={secret}
                      secretPending={secretPending}
                    />
                    <CloneSubmissionsAction
                      org={org}
                      classroom={classroom}
                      assignment={assignment}
                    />
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
                    {canMutate && (
                      <LockAssignmentAction
                        org={org}
                        classroom={classroom}
                        assignment={assignment}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      className="text-base-content/70"
                      onClick={(event) => {
                        event.stopPropagation()
                        setManageSlug(assignment.slug)
                      }}
                      aria-label={t("assignments.manageModal.openAria", {
                        name: name(assignment),
                      })}
                      title={t("assignments.manageModal.open")}
                    >
                      <SlidersIcon aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </td>
              </ClickableTr>
            ))}
        </motion.tbody>
      </TableShell>
      {/* Mounted only while a row's Manage trigger is active, keyed by slug so
          it opens once on mount (same convention as the submission hub). */}
      {manageAssignment && (
        <ManageAssignmentModal
          key={`manage-${manageAssignment.slug}`}
          onClose={() => setManageSlug(null)}
          org={org}
          classroom={classroom}
          assignment={manageAssignment}
          secret={secret}
          secretPending={secretPending}
          canMutate={canMutate}
          onDeleteAssignment={invalidateAssignments}
        />
      )}
    </>
  )
}

export default AssignmentsTable
