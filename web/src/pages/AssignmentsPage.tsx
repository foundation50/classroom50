import { Link, useParams } from "@tanstack/react-router"
import { ChevronDown, Copy, Plus } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import AssignmentsTable from "@/pages/assignments/AssignmentsTable"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { ReuseFromClassroomModal } from "@/components/modals/ReuseFromClassroomModal"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetStudents from "@/hooks/useGetStudents"
import useGetClassroom from "@/hooks/useGetClassroom"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { useCourseTeacherAccess } from "@/hooks/useCourseTeacherAccess"
import { useClassroomRole, roleLabelKey } from "@/hooks/useClassroomRole"
import { useGithubAuth } from "@/auth/useGithubAuth"
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
          <button
            tabIndex={0}
            className="btn btn-primary join-item h-full border-l border-primary-content/20 px-2"
            aria-label={t("assignments.newButton.moreOptions")}
          >
            <ChevronDown aria-hidden="true" className="size-4" />
          </button>
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

const TeacherAssignmentsView = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const { data: classData, isLoading: assignmentsLoading } =
    useGetClassroomAssignments(org, classroom)
  const { students, isLoading: studentsLoading } = useGetStudents(
    org,
    classroom,
  )
  const { data: classroomData, isLoading: classroomLoading } = useGetClassroom(
    org,
    classroom,
  )
  const { user } = useGithubAuth()
  const { role: myRole } = useClassroomRole(org, classroom, user?.login)
  const myRoleLabelKey = roleLabelKey(myRole)
  const myRoleLabel = myRoleLabelKey ? t(myRoleLabelKey) : null
  const archived = isClassroomArchived(classroomData ?? {})
  const emptyRoster = useEmptyRosterWarning(org, classroom)

  return (
    <div>
      <div className="mb-8">
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
              {studentsLoading
                ? "…"
                : t("assignments.studentCount", { count: students.length })}
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
      </div>
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
          className="mb-4"
        />
      ) : null}
      <AssignmentsTable
        org={org}
        classroom={classroom}
        assignments={classData?.assignments}
        students={students}
        loading={assignmentsLoading}
        archived={archived}
      />
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
    <div>
      <div className="mb-8">
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
      </div>
      <OrgRepos org={org} classroom={classroom} />
    </div>
  )
}

const AssignmentsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.assignments"))
  const { org, classroom } = useParams({ strict: false })
  const {
    isTeacher,
    isStudent,
    isLoading: roleLoading,
  } = useCourseTeacherAccess(org)

  return (
    <PageShell selected="assignments">
      <Breadcrumb endpoint={t("nav.assignments")} />
      {roleLoading && (
        <div className="mt-8 space-y-4">
          <div className="skeleton skeleton-shimmer h-6 w-48" />
          <div className="skeleton skeleton-shimmer h-4 w-32" />
          <div className="skeleton skeleton-shimmer h-64 w-full rounded-box" />
        </div>
      )}
      {!roleLoading && isTeacher && org && classroom && (
        <TeacherAssignmentsView org={org} classroom={classroom} />
      )}
      {!roleLoading && isStudent && org && classroom && (
        <StudentAssignmentsView org={org} classroom={classroom} />
      )}
    </PageShell>
  )
}

export default AssignmentsPage
