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
import { useOutageHint } from "@/lib/githubHealth"
import { GitHubStatusNote } from "@/components/GitHubStatusNote"
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
  // The error alert's content and its visibility are tracked separately so the
  // AnimatePresence exit animation keeps rendering the last content while it
  // collapses. Clearing the content on hide (a single `errorMessage` string)
  // would blank the alert mid-collapse; instead we only flip `errorShown` off
  // and leave `errorContent` frozen until the next failure replaces it.
  const [errorContent, setErrorContent] = useState<
    { kind: "message"; message: string } | { kind: "outage" }
  >({ kind: "message", message: "" })
  const [errorShown, setErrorShown] = useState(false)
  const [warningMessage, setWarningMessage] = useState("")

  const outageHint = useOutageHint()
  const outageStatusDescription = outageHint.statusDescription

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
      <RequireRole allow="author">
        <PageHeader title={t("assignments.createHeading")} />
        {emptyRoster.show ? (
          <EmptyRosterNotice
            org={org}
            classroom={classroom}
            hasRosterRows={emptyRoster.hasRosterRows}
          />
        ) : null}
        <AnimatedAlert tone="error" show={errorShown}>
          {errorContent.kind === "outage" ? (
            <GitHubStatusNote statusDescription={outageStatusDescription} />
          ) : (
            errorContent.message
          )}
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
            // Hide the alert but keep its content frozen for the exit collapse;
            // the next failure (if any) replaces the content when it re-shows.
            setErrorShown(false)
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
                release_assets: values.release_assets,
                pass_threshold: values.pass_threshold_enabled
                  ? values.pass_threshold
                  : undefined,
                classroom,
                tests: values.tests,
              },
              {
                onError: (err) => {
                  logWriteFailure(log, err, "create assignment failed")
                  // A transient outage-shaped failure during save reads as a
                  // local "fetch failed" — swap in the outage hint (the strict
                  // classifier keeps a definitive 4xx / rate limit reading as
                  // the real message), so the teacher knows to retry.
                  setErrorContent(
                    outageHint.isOutage(err)
                      ? { kind: "outage" }
                      : { kind: "message", message: err.message },
                  )
                  setErrorShown(true)
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
