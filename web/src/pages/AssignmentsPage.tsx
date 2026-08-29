import { Link, useParams } from "@tanstack/react-router"
import { ChevronDownIcon, CopyIcon, PlusIcon } from "@/components/ui/icons"
import { useMemo, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import AssignmentsTable from "@/pages/assignments/AssignmentsTable"
import AssignmentsToolbar from "@/pages/assignments/AssignmentsToolbar"
import { GitHubAPIError } from "@/github-core/errors"
import { ClassroomCollectButton } from "@/pages/assignments/ClassroomCollectButton"
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  filterAndSortAssignments,
  type AssignmentFilters,
  type AssignmentSort,
} from "@/pages/assignments/assignmentList"
import {
  Badge,
  Button,
  DropdownMenu,
  EmphasisLtr,
  RouterButton,
} from "@/components/ui"
import {
  NoSearchResults,
  SkeletonRegion,
  ToolbarSkeleton,
} from "@/components/list"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import { OrgRepoCreationNotice } from "@/components/OrgRepoCreationNotice"
import { ClaimTeacherNotice } from "./classes/ClaimTeacherNotice"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { ReuseFromClassroomModal } from "@/components/modals/ReuseFromClassroomModal"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useStudentCount from "@/hooks/useStudentCount"
import useGetClassroom from "@/hooks/useGetClassroom"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { roleLabelKey, can } from "@/authz"
import { isClassroomArchived } from "@/types/classroom"
import StudentAssignmentList from "@/components/org/StudentAssignmentList"

// Split button: primary "Assignment" creates; the caret reveals "Reuse
// assignment", pulling one from another classroom into this one.
const NewAssignmentButton = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const [reuseOpen, setReuseOpen] = useState(false)

  return (
    <>
      <div className="join">
        <RouterButton
          to="/$org/$classroom/assignments/new"
          params={{ org, classroom }}
          variant="primary"
          size="sm"
          className="join-item"
        >
          <PlusIcon aria-hidden="true" className="size-4" />{" "}
          {t("assignments.newButton.assignment")}
        </RouterButton>
        {/* Not a join-item: see NewClassroomButton in ClassesPage.tsx. */}
        <div className="dropdown dropdown-end -ms-px">
          <Button
            variant="primary"
            size="sm"
            tabIndex={0}
            className="join-item h-full border-s border-primary-content/20 px-2"
            aria-label={t("assignments.newButton.moreOptions")}
          >
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </Button>
          <DropdownMenu className="w-max">
            <li>
              <button
                type="button"
                onClick={() => {
                  // Close the dropdown before opening the modal so focus
                  // doesn't fight the dialog.
                  ;(document.activeElement as HTMLElement | null)?.blur()
                  setReuseOpen(true)
                }}
              >
                <CopyIcon aria-hidden="true" className="size-4" />{" "}
                {t("assignments.newButton.reuse")}
              </button>
            </li>
          </DropdownMenu>
        </div>
      </div>

      {reuseOpen ? (
        <ReuseFromClassroomModal
          org={org}
          classroom={classroom}
          onClose={() => setReuseOpen(false)}
        />
      ) : null}
    </>
  )
}

export const TeacherAssignmentsView = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const {
    data: classData,
    isLoading: assignmentsLoading,
    error: assignmentsErrorObj,
    refetch: refetchAssignments,
  } = useGetClassroomAssignments(org, classroom)
  // A missing assignments.json 404s — the legitimate zero for a brand-new
  // classroom (same split as ClassroomCard). Only a non-404 failure must be
  // surfaced as an error instead of the empty state.
  const assignmentsNotFound =
    assignmentsErrorObj instanceof GitHubAPIError &&
    assignmentsErrorObj.status === 404
  const assignmentsError = Boolean(assignmentsErrorObj) && !assignmentsNotFound
  // Authoritative student-role count for the header and the table denominator,
  // so neither counts teachers/TAs. The count comes from team membership
  // (one source); roster.csv identity is fetched by useStudentCount internally.
  const {
    studentCount,
    isLoading: studentsLoading,
    isError: studentCountError,
  } = useStudentCount(org, classroom)
  const {
    data: classroomData,
    isLoading: classroomLoading,
    isError: classroomError,
  } = useGetClassroom(org, classroom)
  const { role: myRole } = useClassroomRoleContext()
  const myRoleLabelKey = roleLabelKey(myRole)
  const myRoleLabel = myRoleLabelKey ? t(myRoleLabelKey) : null
  const archived = isClassroomArchived(classroomData ?? {})
  // Author tier (teacher|hta) gates the mutating affordances; a TA sees the
  // list read-only. GitHub is the real enforcer (config-repo write), this is UX.
  const canAuthor = can("authorAssignments", { classroomRole: myRole })
  const emptyRoster = useEmptyRosterWarning(org, classroom)

  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<AssignmentFilters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<AssignmentSort>(DEFAULT_SORT)

  const sourceAssignments = classData?.assignments
  const visible = useMemo(
    () =>
      filterAndSortAssignments(sourceAssignments ?? [], {
        query,
        filters,
        sort,
      }),
    [sourceAssignments, query, filters, sort],
  )

  const hasAssignments = (sourceAssignments?.length ?? 0) > 0
  // The toolbar owns the primary action now (New assignment / archived badge),
  // so it renders whenever the list has loaded — with only the trailing action
  // when there are no assignments yet (actionsOnly), and the full search/filter/
  // sort bar once there are.
  const showToolbar = !assignmentsLoading
  const showNoResults = hasAssignments && visible.length === 0

  // Right-aligned toolbar action: the New assignment split button for an author,
  // or the archived badge; null for a read-only viewer (TA).
  const primaryAction = archived ? (
    <Badge tone="neutral" size="md">
      {t("assignments.archived")}
    </Badge>
  ) : canAuthor ? (
    <NewAssignmentButton org={org} classroom={classroom} />
  ) : null

  // Classroom-wide collect, left-aligned in the toolbar (the `leading` slot),
  // mirroring the submissions toolbar where the DataFreshness/Sync widget
  // leads and search + filters sit on the right. Open to any staff viewer (a
  // TA may collect, as on the submissions page — only authoring is
  // author-gated). Hidden on an archived classroom and while the list is
  // empty: there is no assignment to collect for.
  const collectAction =
    !archived && hasAssignments ? (
      <ClassroomCollectButton
        org={org}
        classroom={classroom}
        emptyRoster={emptyRoster.show}
      />
    ) : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        loading={classroomLoading}
        title={
          <span className="flex items-center gap-2">
            {classroomData?.name || classroomData?.short_name || classroom}
            {myRoleLabel ? (
              <Badge tone="primary" className="align-middle">
                {myRoleLabel}
              </Badge>
            ) : null}
          </span>
        }
        subtitle={
          <>
            {classroomData?.term ? `${classroomData?.term} • ` : ""}
            {studentsLoading
              ? "…"
              : // A failed count is hidden entirely (never a wrong number);
                // the perpetual "…" read as still-loading.
                studentCountError
                ? null
                : t("assignments.studentCount", { count: studentCount ?? 0 })}
          </>
        }
      />
      {archived ? (
        <ArchivedClassroomNotice>
          <Trans
            i18nKey="assignments.archivedNotice"
            components={{
              settingsLink: (
                <Link
                  className="link"
                  to="/$org/$classroom/settings"
                  params={{ org, classroom }}
                />
              ),
            }}
          />
        </ArchivedClassroomNotice>
      ) : emptyRoster.show ? (
        <EmptyRosterNotice
          org={org}
          classroom={classroom}
          hasRosterRows={emptyRoster.hasRosterRows}
        />
      ) : null}
      {/* Catches the drift-after-creation case the create/edit pages can't: a
          teacher who created assignments before the setting flipped never
          reopens those forms, and students accept days later. */}
      <OrgRepoCreationNotice org={org} />
      {showToolbar && (
        <AssignmentsToolbar
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          actionsOnly={!hasAssignments}
          leading={collectAction}
          trailing={primaryAction}
        />
      )}
      {showNoResults ? (
        <NoSearchResults
          title={t("assignments.toolbar.noResultsTitle")}
          body={t("assignments.toolbar.noResultsBody")}
          clearLabel={t("assignments.toolbar.clear")}
          onClear={() => {
            setQuery("")
            setFilters({ ...DEFAULT_FILTERS })
          }}
        />
      ) : (
        <AssignmentsTable
          org={org}
          classroom={classroom}
          secret={classroomData?.secret}
          // A failed read leaves `secret` undefined just like a pending one, so
          // both count as unresolved — else a transient error would re-enable
          // the copy action and hand out a keyless link.
          secretPending={classroomLoading || classroomError}
          assignments={hasAssignments ? visible : sourceAssignments}
          allAssignments={sourceAssignments}
          studentCount={studentCount}
          loading={assignmentsLoading}
          loadError={assignmentsError}
          onRetryLoad={() => void refetchAssignments()}
          archived={archived}
          canAuthor={canAuthor}
          sort={sort}
          onSortChange={setSort}
          // Replay the row entrance on filter/sort changes; search is excluded
          // so typing doesn't remount the rows on every keystroke.
          viewSignature={`${JSON.stringify(filters)}|${sort}`}
        />
      )}
    </div>
  )
}

const StudentAssignmentsView = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("assignments.studentHeading")}
        subtitle={
          <Trans
            i18nKey="assignments.studentViewAll"
            values={{ classroom }}
            components={{ classroom: <EmphasisLtr className="font-bold" /> }}
          />
        }
      />
      <StudentAssignmentList org={org} classroom={classroom} />
    </div>
  )
}

const AssignmentsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.assignments"))
  const { org, classroom } = useParams({ strict: false })
  const { role, roleResolved } = useClassroomRoleContext()
  const isStaff = can("viewClassroomStaffContent", { classroomRole: role })
  const isStudent = role === "student"

  return (
    <PageShell>
      <Breadcrumb endpoint={t("nav.assignments")} />
      {org && classroom && (
        <ClaimTeacherNotice org={org} classroom={classroom} />
      )}
      {!roleResolved && (
        <SkeletonRegion className="space-y-4">
          <ToolbarSkeleton />
          <div className="skeleton skeleton-shimmer h-64 w-full rounded-box" />
        </SkeletonRegion>
      )}
      {roleResolved && isStaff && org && classroom && (
        <TeacherAssignmentsView org={org} classroom={classroom} />
      )}
      {roleResolved && isStudent && org && classroom && (
        <StudentAssignmentsView org={org} classroom={classroom} />
      )}
    </PageShell>
  )
}

export default AssignmentsPage
