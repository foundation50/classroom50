import { useMutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import CreateAssignmentForm, {
  assignmentToFormValues,
} from "./CreateAssignmentForm"
import {
  editAssignmentWithConflictRetry,
  type CreateAssignmentInput,
  type CreateAssignmentResult,
} from "@/api/mutations/assignments"
import { GitHubAPIError } from "@/hooks/github/errors"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
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
  const client = useGitHubClient()
  const { register } = useActionActivityRegistry()
  const editAssignmentMutation = useMutation<
    CreateAssignmentResult,
    GitHubAPIError,
    CreateAssignmentInput
  >({
    mutationFn: (input) => editAssignmentWithConflictRetry(client, input),
    onMutate,
    onSuccess: (result, variables) => {
      // Track the publish-pages deploy this edit's commit triggers, anchored on
      // the commit SHA (head_sha on the runs API).
      if (result.newCommitSha) {
        register({
          org,
          label: t("toasts.publishingAssignment", { name: variables.name }),
          anchor: { kind: "sha", sha: result.newCommitSha },
        })
      }
      onSuccess(result)
    },
    onError,
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
          onCancel={onCancel}
          defaultValues={assignmentToFormValues(defaultData)}
          onSubmit={(values) => {
            editAssignmentMutation.mutate({
              name: values.name,
              mode: values.mode,
              org,
              template_repo: values.template_repo,
              description: values.description,
              due_date: values.due_date,
              max_group_size: values.max_group_size,
              feedback_pr: values.feedback_pr,
              runs_on: values.runs_on,
              container_image: values.container_image,
              container_user: values.container_user,
              runtime_python: values.runtime_python,
              runtime_node: values.runtime_node,
              runtime_java: values.runtime_java,
              runtime_go: values.runtime_go,
              runtime_apt: values.runtime_apt,
              setup_command: values.setup_command,
              allowed_files: values.allowed_files,
              pass_threshold: values.pass_threshold_enabled
                ? values.pass_threshold
                : undefined,
              classroom,
              tests: values.tests,
              slug: assignment,
            })
          }}
        />
      ) : null}
    </LoadingSwap>
  )
}

export default EditAssignmentForm
