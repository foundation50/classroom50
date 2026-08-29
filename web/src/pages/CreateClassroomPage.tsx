import { useParams, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "@/auth/useGithubAuth"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useTrackPublishDeploy } from "@/hooks/useTrackPublishDeploy"
import { useCreateClassroom } from "@/hooks/mutations/useCreateClassroom"
import PageShell from "@/components/PageShell"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import MissingParams from "@/components/MissingParams"
import { logger } from "@/lib/logger"
import { logWriteFailure } from "@/lib/logWriteFailure"
import RequireRole from "@/components/RequireRole"
import CreateClassroomForm from "./classes/CreateClassroomForm"

const log = logger.scope("CreateClassroomPage")

const CreateClassroomPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.newClassroom"))
  const navigate = useNavigate()
  const { notify } = useToast()
  const trackPublishDeploy = useTrackPublishDeploy()
  const { user } = useGithubAuth()
  const { org } = useParams({ strict: false })
  // Failed-create message, rendered inline in the form (the flow stays on
  // this page on error; only success navigates away).
  const [createError, setCreateError] = useState<string | null>(null)

  const createClassroomMutation = useCreateClassroom(
    org ?? "",
    (result, variables) => {
      trackPublishDeploy(
        org ?? "",
        result.newCommitSha,
        t("actionsBanner.workflow.publishClassroom", {
          name: variables.classroom,
        }),
      )
    },
  )

  if (!org) {
    return <MissingParams message={t("classes.missingOrg")} />
  }

  return (
    <PageShell>
      <Breadcrumb endpoint={t("documentTitle.newClassroom")} />
      <RequireRole allow="owner">
        <PageHeader title={t("classes.createTitle")} />
        <CreateClassroomForm
          submitError={createError}
          onSubmit={(values) => {
            setCreateError(null)
            return createClassroomMutation.mutateAsync(
              {
                name: values.name,
                classroom: values.slug,
                org,
                term: values.term,
                secret: values.secret || undefined,
                creator: user?.login,
              },
              {
                onError: (err) => {
                  logWriteFailure(log, err, "create classroom failed")
                  // Stays on the form, so the failure renders inline next to
                  // the create button rather than as a corner toast.
                  setCreateError(
                    t("toasts.classroomCreateFailed", {
                      message: err.message,
                    }),
                  )
                },
                onSuccess: (_result, variables) => {
                  // Toast before navigating: the provider is mounted above the
                  // router, so the confirmation survives the redirect.
                  notify({
                    tone: "success",
                    durationMs: 6000,
                    message: t("toasts.classroomCreated"),
                  })
                  navigate({
                    to: "/$org/$classroom",
                    params: { org, classroom: variables.classroom },
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

export default CreateClassroomPage
