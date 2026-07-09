import { useParams, useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { createClassroomFilesWithConflictRetry } from "@/hooks/github/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { GitHubAPIError } from "@/hooks/github/errors"
import PageShell from "@/components/PageShell"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import MissingParams from "@/components/MissingParams"
import { logger } from "@/lib/logger"
import RequireTeacher from "@/components/RequireTeacher"
import CreateClassroomForm from "./classes/CreateClassroomForm"
import { githubKeys } from "@/hooks/github/queries"
import type {
  CreateClassroomInput,
  CreateClassroomResult,
} from "@/api/mutations/classrooms"

const log = logger.scope("CreateClassroomPage")

const CreateClassroomPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.newClassroom"))
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { notify } = useToast()
  const { register } = useActionActivityRegistry()
  const { user } = useGithubAuth()
  const { org } = useParams({ strict: false })

  const createClassroomMutation = useMutation<
    CreateClassroomResult,
    GitHubAPIError,
    CreateClassroomInput
  >({
    mutationFn: (input) => createClassroomFilesWithConflictRetry(client, input),
    onError: (err) => {
      if (err instanceof GitHubAPIError) {
        // Console-only trace (MutationCache already recorded this failure).
        log.error("create classroom failed", {
          status: err.status,
          requestId: err.requestId,
        })
      } else {
        log.error("non-GitHub API error", { err, record: true })
      }
      notify({
        tone: "error",
        message: t("toasts.classroomCreateFailed", { message: err.message }),
      })
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org ?? "", "classroom50"),
      })
      // Track the publish-pages deploy this commit triggers, anchored on SHA.
      if (org && result.newCommitSha) {
        register({
          org,
          label: t("actionsBanner.workflow.publishClassroom", {
            name: variables.classroom,
          }),
          anchor: { kind: "sha", sha: result.newCommitSha },
        })
      }
      // Toast before navigating: the provider is mounted above the router, so
      // the confirmation survives the redirect.
      notify({
        tone: "success",
        durationMs: 6000,
        message: t("toasts.classroomCreated"),
      })
      navigate({
        to: "/$org/$classroom",
        params: { org: org ?? "", classroom: variables.classroom },
      })
    },
  })

  if (!org) {
    return <MissingParams message={t("classes.missingOrg")} />
  }

  return (
    <PageShell page="classes" selected="classes">
      <Breadcrumb endpoint={t("documentTitle.newClassroom")} />
      <RequireTeacher allow="owner">
        <PageHeader title={t("classes.createTitle")} />
        <CreateClassroomForm
          onSubmit={(values) =>
            createClassroomMutation.mutateAsync({
              name: values.name,
              classroom: values.slug,
              org,
              term: values.term,
              secret: values.secret || undefined,
              creator: user?.login,
            })
          }
        />
      </RequireTeacher>
    </PageShell>
  )
}

export default CreateClassroomPage
