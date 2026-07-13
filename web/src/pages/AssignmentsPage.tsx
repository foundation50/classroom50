import { Link, useParams } from "@tanstack/react-router"
import { ChevronDown, Copy, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import AssignmentsTable from "@/pages/assignments/AssignmentsTable"
import AssignmentsToolbar from "@/pages/assignments/AssignmentsToolbar"
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  filterAndSortAssignments,
  type AssignmentFilters,
  type AssignmentSort,
} from "@/pages/assignments/assignmentList"
import { Button } from "@/components/ui"
import { NoSearchResults } from "@/components/list"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import { ClaimInstructorNotice } from "./classes/ClaimInstructorNotice"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { ReuseFromClassroomModal } from "@/components/modals/ReuseFromClassroomModal"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useStudentCount from "@/hooks/useStudentCount"
import useGetClassroom from "@/hooks/useGetClassroom"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { roleLabelKey } from "@/util/resolveRole"
import { isClassroomArchived } from "@/types/classroom"
import { OrgRepos } from "./ClassesPage"

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
        <Link
          to="/$org/$classroom/assignments/new"
          params={{ org, classroom }}
          className="btn btn-primary join-item"
        >
          <Plus aria-hidden="true" className="size-4" />{" "}
          {t("assignments.newButton.assignment")}
        </Link>
        <div className="dropdown dropdown-end join-item">
          <Button
            variant="primary"
            tabIndex={0}
            className="join-item h-full border-l border-primary-content/20 px-2"
            aria-label={t("assignments.newButton.moreOptions")}
          >
            <ChevronDown aria-hidden="true" className="size-4" />
          </Button>
          <ul
            tabIndex={0}
            className="dropdown-content menu z-10 mt-1 w-max rounded-box border border-base-content/5 bg-base-100 p-1 shadow"
          >
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
                <Copy aria-hidden="true" className="size-4" />{" "}
                {t("assignments.newButton.reuse")}
              </button>
            </li>
          </ul>
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
  const { data: classData, isLoading: assignmentsLoading } =
    useGetClassroomAssignments(org, classroom)
  // Authoritative student-role count for the header and the table denominator,
  // so neither counts instructors/TAs. The count comes from team membership
  // (one source); roster.csv identity is fetched by useStudentCount internally.
  const {
    studentCount,
    isLoading: studentsLoading,
    isError: studentCountError,
  } = useStudentCount(org, classroom)
  const { data: classroomData, isLoading: classroomLoading } = useGetClassroom(
    org,
    classroom,
  )
  const { role: myRole } = useClassroomRoleContext()
  const myRoleLabelKey = roleLabelKey(myRole)
  const myRoleLabel = myRoleLabelKey ? t(myRoleLabelKey) : null
  const archived = isClassroomArchived(classroomData ?? {})
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
  const showToolbar = !assignmentsLoading && hasAssignments
  const showNoResults = showToolbar && visible.length === 0

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        loading={classroomLoading}
        title={
          <span className="flex items-center gap-2">
            {classroomData?.name || classroomData?.short_name || classroom}
            {myRoleLabel ? (
              <span className="badge badge-soft badge-primary badge-sm align-middle">
                {myRoleLabel}
              </span>
            ) : null}
          </span>
        }
        subtitle={
          <>
            {classroomData?.term ? `${classroomData?.term} • ` : ""}
            {studentsLoading || studentCountError
              ? "…"
              : t("assignments.studentCount", { count: studentCount ?? 0 })}
          </>
        }
        action={
          archived ? (
            <span className="badge badge-soft badge-neutral">
              {t("assignments.archived")}
            </span>
          ) : (
            <NewAssignmentButton org={org} classroom={classroom} />
          )
        }
      />
      {archived ? (
        <ArchivedClassroomNotice>
          {t("assignments.archivedNotice_prefix")}{" "}
          <Link
            className="link"
            to="/$org/$classroom/edit"
            params={{ org, classroom }}
          >
            {t("assignments.archivedNotice_link")}
          </Link>{" "}
          {t("assignments.archivedNotice_suffix")}
        </ArchivedClassroomNotice>
      ) : emptyRoster.show ? (
        <EmptyRosterNotice
          org={org}
          classroom={classroom}
          hasRosterRows={emptyRoster.hasRosterRows}
        />
      ) : null}
      {showToolbar && (
        <AssignmentsToolbar
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
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
          assignments={hasAssignments ? visible : sourceAssignments}
          studentCount={studentCount}
          loading={assignmentsLoading}
          archived={archived}
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
          <>
            {t("assignments.studentViewAll_prefix")}{" "}
            <span className="font-bold">{classroom}</span>{" "}
            {t("assignments.studentViewAll_suffix")}
          </>
        }
      />
      <OrgRepos org={org} classroom={classroom} />
    </div>
  )
}

const AssignmentsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.assignments"))
  const { org, classroom } = useParams({ strict: false })
  const { isTeacher, isStudent, roleResolved } = useClassroomRoleContext()

  return (
    <PageShell selected="assignments">
      <Breadcrumb endpoint={t("nav.assignments")} />
      {org && classroom && (
        <ClaimInstructorNotice org={org} classroom={classroom} />
      )}
      {!roleResolved && (
        <div className="space-y-4">
          <div className="skeleton skeleton-shimmer h-6 w-48" />
          <div className="skeleton skeleton-shimmer h-4 w-32" />
          <div className="skeleton skeleton-shimmer h-64 w-full rounded-box" />
        </div>
      )}
      {roleResolved && isTeacher && org && classroom && (
        <TeacherAssignmentsView org={org} classroom={classroom} />
      )}
      {roleResolved && isStudent && org && classroom && (
        <StudentAssignmentsView org={org} classroom={classroom} />
      )}
    </PageShell>
  )
}

export default AssignmentsPage
