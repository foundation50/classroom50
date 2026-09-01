import { useState } from "react"
import { FormSkeleton } from "@/components/list"
import { Link, useParams, useRouter } from "@tanstack/react-router"
import { MarkGithubIcon, PeopleIcon } from "@/components/ui/icons"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { OrgRepoCreationNotice } from "@/components/OrgRepoCreationNotice"
import { Alert, AnimatedAlert, Button, Card, Heading } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import { useClassroomSecret } from "@/hooks/useStudentClassrooms"

import { useGithubAuth } from "@/auth/useGithubAuth"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { GroupTeamMembersPanel } from "@/components/assignments/GroupTeamMembersPanel"
import useMyGroupTeam from "@/hooks/useMyGroupTeam"
import { GROUP_REPO_SEGMENT } from "@/util/studentRepo"
import EditAssignmentForm from "./assignments/EditAssignmentForm"
import RenameSlugSection from "./assignments/RenameSlugSection"
import ManageGroupsCard from "./manageGroups/ManageGroupsCard"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetClassroom from "@/hooks/useGetClassroom"
import { isClassroomArchived } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Trans, useTranslation } from "react-i18next"
import { errorText } from "@/types/localizedMessage"

const EditAssignmentFormStudent = ({
  org,
  classroom,
  assignment,
}: {
  org: string
  classroom: string
  assignment: string
}) => {
  const { t } = useTranslation()
  const { user } = useGithubAuth()
  // Custom Pages base URL + capability secret from the team-description
  // bootstrap record; the read waits for it so a custom-domain org never
  // fires a doomed github.io fetch.
  const {
    secret: teamSecret,
    pagesBaseUrl,
    isLoading: loadingBootstrap,
  } = useClassroomSecret(org, classroom)
  // Mode first (public manifest), then the repo: team mode resolves the shared
  // group repo through the viewer's team membership, not the username formula.
  const { data: preAssignments } = usePagesAssignments(
    org,
    classroom,
    teamSecret,
    {
      pagesBaseUrl,
      enabled: !loadingBootstrap,
    },
  )
  const preMode = preAssignments?.find((a) => a.slug === assignment)?.mode
  const isTeamMode = preMode === "team"
  const { data: myTeam, isLoading: loadingMyTeam } = useMyGroupTeam(
    org,
    classroom,
    assignment,
    { enabled: isTeamMode && Boolean(user?.login) },
  )
  const repoOwnerSegment = isTeamMode
    ? myTeam
      ? `${GROUP_REPO_SEGMENT}${myTeam.n}`
      : undefined
    : user?.login
  const { isLoading: loadingRepo, assignment: assignmentRepo } =
    useGetAssignmentRepo(org, classroom, assignment, repoOwnerSegment)
  // Post-accept, so the capability-URL secret (protected classroom) lives in
  // the student's repo .classroom50.yaml — the source they can read (not the
  // private classroom.json). Empty for unprotected -> plain path.
  const { secret } = useDotClassroom50(org, assignmentRepo?.name ?? "")
  const { isLoading: loadingPublic, assignment: assignmentData } =
    usePagesAssignments(org, classroom, secret, {
      assignmentSlug: assignment,
      pagesBaseUrl,
      enabled: !loadingBootstrap,
    })

  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false)

  // max_group_size includes the owner, so the addable count is one less.
  const maxCollaborators = Math.max(
    (assignmentData?.max_group_size ?? 1) - 1,
    0,
  )
  const assignmentMode = assignmentData?.mode

  if (
    loadingPublic ||
    loadingRepo ||
    loadingBootstrap ||
    (isTeamMode && loadingMyTeam)
  ) {
    return <FormSkeleton fields={3} label={t("assignmentSettings.loading")} />
  }

  if (!assignmentRepo) {
    return (
      <EnterDiv className="mt-6">
        <Alert tone="info">
          <div>
            <Trans
              i18nKey="assignmentSettings.notAccepted"
              components={{
                acceptLink: (
                  <Link
                    className="underline"
                    to="/$org/$classroom/assignments/$assignment/accept"
                    params={{ org, classroom, assignment }}
                  />
                ),
              }}
            />
          </div>
        </Alert>
      </EnterDiv>
    )
  }

  if (assignmentMode === "individual") {
    return (
      <div className="mt-6">
        <Alert tone="info">
          <div>
            <Trans
              i18nKey="assignmentSettings.individual"
              components={{
                submissionLink: (
                  <Link
                    className="underline"
                    to="/$org/$classroom/assignments/$assignment/submission"
                    params={{ org, classroom, assignment }}
                  />
                ),
              }}
            />
          </div>
        </Alert>
      </div>
    )
  }

  // Team mode: members flow through the group's GitHub Team, so the legacy
  // direct-collaborators modal doesn't apply — render the live member panel.
  if (assignmentMode === "team" && myTeam) {
    return (
      <Card bordered={false} className="mb-6 w-full border border-base-200">
        <Card.Body className="gap-6">
          <div className="flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
              <PeopleIcon aria-hidden="true" className="size-6" />
            </div>
            <div>
              <Heading as="h1" variant="title-medium">
                {assignmentData?.name}
              </Heading>
              <p className="text-sm font-medium text-base-content/70">
                {t("assignmentSettings.groupMembers")}
              </p>
              <a
                className="link mt-1 inline-flex items-center gap-1.5 text-sm"
                href={assignmentRepo.html_url}
                target="_blank"
                rel="noreferrer"
              >
                <MarkGithubIcon aria-hidden="true" className="size-4" />
                {t("assignmentSettings.viewRepository")}
              </a>
            </div>
          </div>
          <GroupTeamMembersPanel
            org={org}
            classroom={classroom}
            assignment={assignment}
            teamSlug={myTeam.slug}
            teamName={myTeam.name}
            maxGroupSize={assignmentData?.max_group_size}
            viewerLogin={user?.login}
            formation={assignmentData?.team_formation}
          />
        </Card.Body>
      </Card>
    )
  }

  return (
    <>
      <Card bordered={false} className="mb-6 w-full border border-base-200">
        <Card.Body className="gap-6">
          <div className="flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
              <PeopleIcon aria-hidden="true" className="size-6" />
            </div>

            <div>
              <Heading as="h1" variant="title-medium">
                {assignmentData?.name}
              </Heading>
              <p className="text-sm font-medium text-base-content/70">
                {t("assignmentSettings.groupMembers")}
              </p>
              <a
                className="link mt-1 inline-flex items-center gap-1.5 text-sm"
                href={assignmentRepo.html_url}
                target="_blank"
                rel="noreferrer"
              >
                <MarkGithubIcon aria-hidden="true" className="size-4" />
                {t("assignmentSettings.viewRepository")}
              </a>
              <p className="mt-2 text-sm text-base-content/70">
                <Trans
                  i18nKey="assignmentSettings.collaboratorsHint"
                  count={maxCollaborators}
                  components={{
                    count: <span className="font-semibold text-base-content" />,
                  }}
                />
              </p>
            </div>
          </div>

          <Card.Actions className="justify-end border-t border-base-200 pt-6">
            <Button
              variant="primary"
              onClick={() => setCollaboratorsOpen(true)}
            >
              {t("assignmentSettings.manageCollaborators")}
            </Button>
          </Card.Actions>
        </Card.Body>
      </Card>

      {user?.login && (
        <GroupCollaboratorsModal
          open={collaboratorsOpen}
          onClose={() => setCollaboratorsOpen(false)}
          org={org}
          repoName={assignmentRepo.name}
          repoUrl={assignmentRepo.html_url}
          ownerLogin={user.login}
          assignmentName={assignmentData?.name}
          maxGroupSize={assignmentData?.max_group_size}
        />
      )}
    </>
  )
}

const AssignmentSettingsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.assignmentSettings"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const router = useRouter()
  const { role } = useClassroomRoleContext()
  const isStaff = can("viewClassroomStaffContent", { classroomRole: role })
  const canAuthor = can("authorAssignments", { classroomRole: role })
  const isStudent = role === "student"
  const { data: assignments } = useGetClassroomAssignments(org, classroom)
  const { data: classroomData } = useGetClassroom(org, classroom)
  const archived = isClassroomArchived(classroomData ?? {})
  const [editSuccess, setEditSuccess] = useState(false)
  const [editWarning, setEditWarning] = useState("")
  const [editError, setEditError] = useState("")

  // Match by renamed_from too: after a slug rename the route still carries
  // the OLD slug, and without the fallback the refetched manifest resolves
  // undefined here — unmounting the rename section and its open modal
  // mid-report. The reservation rule guarantees no entry's slug equals
  // another's renamed_from, so the fallback can't shadow an exact match.
  const assignmentData = assignments?.assignments.find(
    (a) =>
      a.slug === assignment ||
      (Boolean(a.renamed_from) &&
        a.renamed_from?.toLowerCase() === assignment?.toLowerCase()),
  )

  return (
    <PageShell>
      <Breadcrumb
        endpoint={t("documentTitle.assignmentSettings")}
        assignmentName={assignmentData?.name}
      />
      <AnimatedAlert tone="error" show={!!editError}>
        {editError}
      </AnimatedAlert>
      <AnimatedAlert tone="success" show={editSuccess}>
        {t("assignmentSettings.editSuccess")}
      </AnimatedAlert>
      <AnimatedAlert tone="warning" show={!!editWarning}>
        {editWarning}
      </AnimatedAlert>
      <PageHeader title={t("assignmentSettings.heading")} />
      {isStaff && archived && (
        <ArchivedClassroomNotice>
          <Trans
            i18nKey="assignmentSettings.archivedNotice"
            components={{
              settingsLink: (
                <Link
                  className="link"
                  to="/$org/$classroom/settings"
                  params={{ org: org ?? "", classroom: classroom ?? "" }}
                />
              ),
            }}
          />
        </ArchivedClassroomNotice>
      )}
      {isStaff && org && classroom && assignment && (
        <>
          <OrgRepoCreationNotice org={org} />
          {/* One-shot slug-update remediation (#691), above the form so the
              teacher sees it before editing: renders only when the slug is
              over the repo-name budget (or a prior update left stragglers),
              and only for authors on an active classroom. */}
          {canAuthor && !archived && assignmentData && (
            <RenameSlugSection
              org={org}
              classroom={classroom}
              assignment={assignmentData}
              assignments={assignments?.assignments ?? []}
            />
          )}
          {/* Team-mode group management moved to its own routed page; this is
              the compact pointer with the current group count. */}
          {!archived && assignmentData?.mode === "team" && (
            <ManageGroupsCard
              org={org}
              classroom={classroom}
              assignmentSlug={assignmentData.slug}
            />
          )}
          <EditAssignmentForm
            org={org}
            classroom={classroom}
            assignment={assignment}
            defaultData={assignmentData}
            readOnly={archived || !canAuthor}
            onCancel={() => {
              router.history.back()
            }}
            onMutate={() => {
              // Clear prior banners so a re-edit never shows stale state.
              setEditSuccess(false)
              setEditWarning("")
              setEditError("")
            }}
            onError={(error) => {
              setEditError(errorText(t, error))
              window.scrollTo({ top: 0, behavior: "smooth" })
            }}
            onSuccess={(result) => {
              // Surface a non-fatal template-grant warning inline; else show
              // the success banner. It persists until the next save clears it
              // via onMutate (Primer: don't auto-dismiss status messages).
              if (result?.templateGrantWarning) {
                setEditWarning(result.templateGrantWarning)
              } else {
                setEditSuccess(true)
              }
              window.scrollTo({ top: 0, behavior: "smooth" })
            }}
          />
        </>
      )}
      {isStudent && org && classroom && assignment && (
        <EditAssignmentFormStudent
          org={org}
          classroom={classroom}
          assignment={assignment}
        />
      )}
    </PageShell>
  )
}

export default AssignmentSettingsPage
