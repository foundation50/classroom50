import { Link, Navigate, useParams } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { OrgRepoCreationNotice } from "@/components/OrgRepoCreationNotice"
import { Alert } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetClassroom from "@/hooks/useGetClassroom"
import { isClassroomArchived } from "@/types/classroom"
import { GroupsManager } from "./manageGroups/GroupsManager"

const ManageGroupsContent = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: string
}) => {
  const { t } = useTranslation()
  const { data: assignments, isLoading } = useGetClassroomAssignments(
    org,
    classroom,
  )
  const { data: classroomData } = useGetClassroom(org, classroom)
  const archived = isClassroomArchived(classroomData ?? {})

  // Match by renamed_from too, like the settings page: after a slug rename the
  // route still carries the OLD slug until links catch up.
  const assignmentData = assignments?.assignments.find(
    (a) =>
      a.slug === assignment ||
      (Boolean(a.renamed_from) &&
        a.renamed_from?.toLowerCase() === assignment.toLowerCase()),
  )

  return (
    <PageShell>
      <Breadcrumb
        endpoint={t("documentTitle.manageGroups")}
        assignmentName={assignmentData?.name}
      />
      <PageHeader title={t("manageGroups.title")} />
      {archived && (
        <ArchivedClassroomNotice>
          <Trans
            i18nKey="manageGroups.archivedNotice"
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
      )}
      <OrgRepoCreationNotice org={org} />
      {isLoading || !assignments ? (
        <div className="flex py-10">
          <Spinner className="m-auto" label={t("manageGroups.loading")} />
        </div>
      ) : !assignmentData || assignmentData.mode !== "team" ? (
        // Groups only exist for team-mode assignments; point everything else
        // back at the assignment's settings.
        <Alert tone="info">
          <div>
            <Trans
              i18nKey="manageGroups.notTeamMode"
              components={{
                settingsLink: (
                  <Link
                    className="underline"
                    to="/$org/$classroom/assignments/$assignment/settings"
                    params={{ org, classroom, assignment }}
                  />
                ),
              }}
            />
          </div>
        </Alert>
      ) : archived ? null : (
        <GroupsManager
          org={org}
          classroom={classroom}
          assignmentSlug={assignmentData.slug}
          maxGroupSize={assignmentData.max_group_size}
          formation={assignmentData.team_formation ?? "teacher"}
        />
      )}
    </PageShell>
  )
}

// Staff-only, like the gradebook: wait for the classroom role to resolve so a
// real teacher never bounces, then send students to their own settings view.
const ManageGroupsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.manageGroups"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const { role, roleResolved } = useClassroomRoleContext()

  if (!org || !classroom || !assignment) {
    return <MissingParams message={t("manageGroups.missingParams")} />
  }

  if (!roleResolved) {
    return <RoleResolvingFallback className="min-h-screen" />
  }

  if (!can("viewClassroomStaffContent", { classroomRole: role })) {
    return (
      <Navigate
        to="/$org/$classroom/assignments/$assignment/settings"
        params={{ org, classroom, assignment }}
        replace
      />
    )
  }

  return (
    <ManageGroupsContent
      org={org}
      classroom={classroom}
      assignment={assignment}
    />
  )
}

export default ManageGroupsPage
