import { useState } from "react"
import { Link, useParams, useRouter } from "@tanstack/react-router"
import { UsersRound } from "lucide-react"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { Spinner } from "@/components/Spinner"
import { Alert, AnimatedAlert, Button, Card } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/util/capabilities"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import useDotClassroom50 from "@/hooks/useDotClassroom50"

import GitHub from "@/assets/github.svg?react"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import EditAssignmentForm from "./assignments/EditAssignmentForm"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetClassroom from "@/hooks/useGetClassroom"
import { isClassroomArchived } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { useTranslation } from "react-i18next"

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
  const { isLoading: loadingRepo, assignment: assignmentRepo } =
    useGetAssignmentRepo(org, classroom, assignment, user?.login)
  // Post-accept, so the capability-URL secret (protected classroom) lives in
  // the student's repo .classroom50.yaml — the source they can read (not the
  // private classroom.json). Empty for unprotected -> plain path.
  const { secret } = useDotClassroom50(org, assignmentRepo?.name ?? "")
  const { isLoading: loadingPublic, assignment: assignmentData } =
    useGetPublicAssignment(org, classroom, assignment, secret)

  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false)

  // max_group_size includes the owner, so the addable count is one less.
  const maxCollaborators = Math.max(
    (assignmentData?.max_group_size ?? 1) - 1,
    0,
  )
  const assignmentMode = assignmentData?.mode

  if (loadingPublic || loadingRepo) {
    return (
      <div className="flex">
        <Spinner className="m-auto" label={t("assignmentSettings.loading")} />
      </div>
    )
  }

  if (!assignmentRepo) {
    return (
      <EnterDiv className="alert alert-info alert-soft mt-6">
        <div>
          {t("assignmentSettings.notAccepted_prefix")}{" "}
          <Link
            className="underline"
            to="/$org/$classroom/assignments/$assignment/accept"
            params={{ org, classroom, assignment }}
          >
            {t("assignmentSettings.notAccepted_link")}
          </Link>{" "}
          {t("assignmentSettings.notAccepted_suffix")}
        </div>
      </EnterDiv>
    )
  }

  if (assignmentMode === "individual") {
    return (
      <div className="mt-6">
        <Alert tone="info">
          <div>
            {t("assignmentSettings.individual_prefix")}{" "}
            <Link
              className="underline"
              to="/$org/$classroom/assignments/$assignment/submission"
              params={{ org, classroom, assignment }}
            >
              {t("assignmentSettings.individual_link")}
            </Link>
            {t("assignmentSettings.individual_suffix")}
          </div>
        </Alert>
      </div>
    )
  }

  return (
    <>
      <Card bordered={false} className="mb-6 w-full border border-base-200">
        <Card.Body className="gap-6">
          <div className="flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <UsersRound aria-hidden="true" className="size-6" />
            </div>

            <div>
              <h1 className="card-title text-xl">{assignmentData?.name}</h1>
              <p className="text-sm font-medium text-base-content/70">
                {t("assignmentSettings.groupMembers")}
              </p>
              <a
                className="link mt-1 inline-flex items-center gap-1.5 text-sm"
                href={assignmentRepo.html_url}
                target="_blank"
                rel="noreferrer"
              >
                <GitHub aria-hidden="true" className="size-4" />
                {t("assignmentSettings.viewRepository")}
              </a>
              <p className="mt-2 text-sm text-base-content/70">
                {t("assignmentSettings.collaboratorsHint_prefix")}{" "}
                <span className="font-semibold text-base-content">
                  {maxCollaborators}
                </span>{" "}
                {t("assignmentSettings.collaboratorsHint_suffix", {
                  count: maxCollaborators,
                })}
              </p>
            </div>
          </div>

          <Card.Actions className="justify-end border-t border-base-200 pt-6">
            <Button
              variant="primary"
              onClick={() => setCollaboratorsOpen(true)}
            >
              <UsersRound aria-hidden="true" className="size-4" />
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

const EditAssignmentPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.assignmentSettings"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const router = useRouter()
  const { role } = useClassroomRoleContext()
  const isStaff = can("viewClassroomStaffContent", { classroomRole: role })
  const isStudent = role === "student"
  const { data: assignments } = useGetClassroomAssignments(org, classroom)
  const { data: classroomData } = useGetClassroom(org, classroom)
  const archived = isClassroomArchived(classroomData ?? {})
  const [editSuccess, setEditSuccess] = useState(false)
  const [editWarning, setEditWarning] = useState("")
  const [editError, setEditError] = useState("")

  const assignmentData = assignments?.assignments.find(
    (a) => a.slug === assignment,
  )

  return (
    <PageShell selected="assignments">
      <Breadcrumb endpoint={t("documentTitle.assignmentSettings")} />
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
          {t("assignmentSettings.archivedNotice_prefix")}{" "}
          <Link
            className="link"
            to="/$org/$classroom/edit"
            params={{ org: org ?? "", classroom: classroom ?? "" }}
          >
            {t("assignmentSettings.archivedNotice_link")}
          </Link>{" "}
          {t("assignmentSettings.archivedNotice_suffix")}
        </ArchivedClassroomNotice>
      )}
      {isStaff && org && classroom && assignment && (
        <EditAssignmentForm
          org={org}
          classroom={classroom}
          assignment={assignment}
          defaultData={assignmentData}
          readOnly={archived}
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
            setEditError(error.message)
            window.scrollTo({ top: 0, behavior: "smooth" })
          }}
          onSuccess={(result) => {
            // Surface a non-fatal template-grant warning inline; else show
            // the success banner.
            if (result?.templateGrantWarning) {
              setEditWarning(result.templateGrantWarning)
            } else {
              setEditSuccess(true)
              setTimeout(() => setEditSuccess(false), 3000)
            }
            window.scrollTo({ top: 0, behavior: "smooth" })
          }}
        />
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

export default EditAssignmentPage
