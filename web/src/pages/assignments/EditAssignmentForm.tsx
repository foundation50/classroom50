import { useTranslation } from "react-i18next"
import CreateAssignmentForm, {
  assignmentToFormValues,
} from "./CreateAssignmentForm"
import { type CreateAssignmentResult } from "@/domain/assignments"
import { GitHubAPIError } from "@/github-core/errors"
import { useTrackPublishDeploy } from "@/hooks/useTrackPublishDeploy"
import { useEditAssignment } from "@/hooks/mutations/useEditAssignment"
import { LoadingSwap } from "@/lib/LoadingSwap"
import { Spinner } from "@/components/Spinner"

const EditAssignmentForm = ({
  org,
  classroom,
  assignment,
  defaultData,
  onSuccess,
  onError,
  onMutate,
  onCancel,
  readOnly = false,
}: {
  org: string
  classroom: string
  assignment: string
  defaultData: Parameters<typeof assignmentToFormValues>[0] | undefined
  onSuccess: (result: CreateAssignmentResult) => void
  onError?: (error: GitHubAPIError) => void
  onMutate?: () => void
  onCancel?: () => void
  // View the assignment config read-only (e.g. an archived classroom).
  readOnly?: boolean
}) => {
  const { t } = useTranslation()
  const trackPublishDeploy = useTrackPublishDeploy()
  const editAssignmentMutation = useEditAssignment({
    onWrite: (result, variables) => {
      // newCommitSha is the runs API's head_sha.
      trackPublishDeploy(
        org,
        result.newCommitSha,
        t("toasts.publishingAssignment", { name: variables.name }),
      )
    },
    onMutate,
  })

  return (
    <LoadingSwap
      loading={!defaultData}
      fallback={
        <div className="flex">
          <Spinner className="m-auto" label={t("assignmentSettings.loading")} />
        </div>
      }
    >
      {defaultData ? (
        <CreateAssignmentForm
          edit
          readOnly={readOnly}
          loading={editAssignmentMutation.isPending}
          org={org}
          classroom={classroom}
          slug={assignment}
          onCancel={onCancel}
          defaultValues={assignmentToFormValues(defaultData)}
          onSubmit={(values) => {
            editAssignmentMutation.mutate(
              {
                name: values.name,
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
                slug: assignment,
              },
              {
                onSuccess: (result) => onSuccess(result),
                onError,
              },
            )
          }}
        />
      ) : null}
    </LoadingSwap>
  )
}

export default EditAssignmentForm
