import { useNavigate, useParams } from "@tanstack/react-router"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import RequireRole from "@/components/RequireRole"
import { AnimatedAlert, Button } from "@/components/ui"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import CreateAssignmentForm from "@/pages/assignments/CreateAssignmentForm"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useCreateAssignment } from "@/hooks/mutations/useCreateAssignment"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useTrackPublishDeploy } from "@/hooks/useTrackPublishDeploy"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { logger } from "@/lib/logger"
import { logWriteFailure } from "@/lib/logWriteFailure"
import { useState } from "react"
import { useTranslation } from "react-i18next"

const log = logger.scope("CreateAssignmentPage")

const CreateAssignmentPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.newAssignment"))
  const navigate = useNavigate()
  const { org, classroom } = useParams({ strict: false })
  const { notify } = useToast()
  const trackPublishDeploy = useTrackPublishDeploy()
  const [errorMessage, setErrorMessage] = useState("")
  const [warningMessage, setWarningMessage] = useState("")

  const { data: assignmentsData } = useGetClassroomAssignments(org, classroom)
  const takenSlugs = (assignmentsData?.assignments ?? []).map((a) => a.slug)

  const emptyRoster = useEmptyRosterWarning(org, classroom)

  const createAssignmentMutation = useCreateAssignment(
    org ?? "",
    classroom ?? "",
    (result, variables) => {
      trackPublishDeploy(
        org ?? "",
        result.newCommitSha,
        t("toasts.publishingAssignment", { name: variables.name }),
      )
    },
  )

  if (!org || !classroom) {
    return <MissingParams message={t("assignments.missingOrgOrClassroom")} />
  }
  return (
    <PageShell selected="assignments">
      <Breadcrumb endpoint={t("assignments.createBreadcrumb")} />
      <RequireRole>
        <PageHeader title={t("assignments.createHeading")} />
        {emptyRoster.show ? (
          <EmptyRosterNotice
            org={org}
            classroom={classroom}
            hasRosterRows={emptyRoster.hasRosterRows}
          />
        ) : null}
        <AnimatedAlert tone="error" show={!!errorMessage}>
          {errorMessage}
        </AnimatedAlert>
        <AnimatedAlert
          tone="warning"
          show={!!warningMessage}
          className="flex flex-col items-start gap-2"
        >
          <span>{warningMessage}</span>
          <Button
            size="sm"
            onClick={() =>
              navigate({
                to: "/$org/$classroom/assignments",
                params: { org, classroom },
              })
            }
          >
            {t("assignments.goToAssignments")}
          </Button>
        </AnimatedAlert>
        <CreateAssignmentForm
          loading={createAssignmentMutation.isPending}
          org={org}
          classroom={classroom}
          takenSlugs={takenSlugs}
          onSubmit={(values) => {
            setErrorMessage("")
            setWarningMessage("")
            createAssignmentMutation.mutateAsync(
              {
                name: values.name,
                slug: values.slug,
                mode: values.mode,
                org,
                template_repo: values.template_repo,
                description: values.description,
                due_date: values.due_date,
                max_group_size: values.max_group_size,
                feedback_pr: values.feedback_pr,
                empty_repo: values.empty_repo,
                runs_on: values.runs_on,
                container_image: values.container_image,
                container_user: values.container_user,
                runtime_python: values.runtime_python,
                runtime_node: values.runtime_node,
                runtime_java: values.runtime_java,
                runtime_go: values.runtime_go,
                runtime_rust: values.runtime_rust,
                runtime_apt: values.runtime_apt,
                setup_command: values.setup_command,
                allowed_files: values.allowed_files,
                pass_threshold: values.pass_threshold_enabled
                  ? values.pass_threshold
                  : undefined,
                classroom,
                tests: values.tests,
              },
              {
                onError: (err) => {
                  logWriteFailure(log, err, "create assignment failed")
                  setErrorMessage(err.message)
                  window.scrollTo({ top: 0, behavior: "smooth" })
                },
                onSuccess: (result, variables) => {
                  // If the template team grant failed, stay on the page to show
                  // the warning instead of navigating away.
                  if (result.templateGrantWarning) {
                    setWarningMessage(result.templateGrantWarning)
                    window.scrollTo({ top: 0, behavior: "smooth" })
                    return
                  }
                  // Toast before navigating: the provider is mounted above the
                  // router, so the confirmation survives the redirect.
                  notify({
                    tone: "success",
                    durationMs: 6000,
                    message: t("toasts.assignmentCreated"),
                  })
                  navigate({
                    to: "/$org/$classroom/assignments/$assignment",
                    params: {
                      org,
                      classroom,
                      assignment: variables.slug,
                    },
                  })
                },
              },
            )
          }}
        />
      </RequireRole>
    </PageShell>
  )
}

export default CreateAssignmentPage
