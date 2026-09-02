import { useMemo, useRef, useState } from "react"
import { FormSkeleton } from "@/components/list"
import { useTranslation } from "react-i18next"
import CreateAssignmentForm, {
  assignmentToFormValues,
  formValuesToRepoFeatures,
  formValuesToTestDefaults,
} from "./CreateAssignmentForm"
import { deriveFormShape } from "./formShape"
import {
  editImpactSummary,
  type CreateAssignmentResult,
  type EditImpact,
} from "@/domain/assignments"
import type { Assignment } from "@/types/classroom"
import { GitHubAPIError } from "@/github-core/errors"
import { useTrackPublishDeploy } from "@/hooks/useTrackPublishDeploy"
import { useEditAssignment } from "@/hooks/mutations/useEditAssignment"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useGetStudents from "@/hooks/useGetStudents"
import { assignmentRepoNames } from "@/pages/submissions/dashboard"
import { EditImpactConfirmModal } from "@/components/modals/EditImpactConfirmModal"
import { LoadingSwap } from "@/lib/LoadingSwap"
import { parseSubmissionTags } from "@/util/submissionTags"

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
  defaultData: Assignment | undefined
  onSuccess: (result: CreateAssignmentResult) => void
  onError?: (error: GitHubAPIError) => void
  onMutate?: () => void
  onCancel?: () => void
  // View the assignment config read-only (e.g., an archived classroom).
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

  // Deterministic acceptance count for this assignment, derived from the org
  // repo list + roster the same way the submissions page does (no per-student
  // fetch). Gates the provisioning half of the edit confirm: zero accepted → a
  // provisioning change saves silently; one or more → confirm first. Both reads
  // are cached and shared with other views, so this adds no dedicated request
  // beyond what a staff member already loads.
  const { data: orgRepos } = useGetOrgRepos(org)
  const { students } = useGetStudents(org, classroom)
  const isGroup = defaultData?.mode === "group"
  const acceptedCount = useMemo(
    () =>
      assignmentRepoNames({
        isGroup,
        repos: orgRepos,
        classroom,
        assignment,
        students,
      }).length,
    [isGroup, orgRepos, classroom, assignment, students],
  )

  // An edit that changes what students can do or see (lock/unlock, or a
  // provisioning-class setting once students accepted) is confirmed before it
  // writes. The submit is deferred through a promise the modal resolves
  // (confirm) or rejects-as-cancel (so the form stays dirty and re-submittable,
  // matching a failed write).
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingImpact, setPendingImpact] = useState<EditImpact[]>([])
  const pendingSubmit = useRef<{
    run: () => Promise<void>
    resolve: () => void
    reject: (reason?: unknown) => void
  } | null>(null)

  const closeConfirm = () => {
    setConfirmOpen(false)
    // Treat a dismissal as a cancel: reject the deferred submit so the form's
    // onSubmit rejects and the form is left dirty (no reset), never written.
    const pending = pendingSubmit.current
    pendingSubmit.current = null
    pending?.reject(new Error("edit-confirm-cancelled"))
  }

  const confirmSubmit = async () => {
    const pending = pendingSubmit.current
    if (!pending) return
    try {
      await pending.run()
      pending.resolve()
    } catch (err) {
      pending.reject(err)
    } finally {
      pendingSubmit.current = null
      setConfirmOpen(false)
    }
  }

  return (
    <LoadingSwap
      loading={!defaultData}
      fallback={
        <FormSkeleton fields={6} label={t("assignmentSettings.loading")} />
      }
    >
      {defaultData ? (
        <>
          <CreateAssignmentForm
            edit
            readOnly={readOnly}
            loading={editAssignmentMutation.isPending}
            org={org}
            classroom={classroom}
            slug={assignment}
            hasAcceptedStudents={acceptedCount > 0}
            onCancel={onCancel}
            defaultValues={assignmentToFormValues(defaultData)}
            onSubmit={async (values) => {
              const shape = deriveFormShape(values)
              const input = {
                name: values.name,
                mode: values.mode,
                org,
                template_repo: values.template_repo,
                description: values.description,
                due_date: values.due_date,
                available_from_date: values.available_from_date,
                locked: values.locked,
                max_group_size: values.max_group_size,
                team_formation: values.team_formation,
                feedback_pr: values.feedback_pr,
                feedback_pr_template: values.feedback_pr_template,
                empty_repo: values.empty_repo,
                no_autograder: shape.noAutograder,
                init_shim: shape.initShim,
                include_all_branches: values.include_all_branches,
                copy_about: values.copy_about,
                copy_topics: values.copy_topics,
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
                setup_timeout: values.setup_timeout,
                allowed_files: values.allowed_files,
                release_assets: values.release_assets,
                pass_threshold: values.pass_threshold_enabled
                  ? values.pass_threshold
                  : undefined,
                student_permission: values.student_permission || undefined,
                repo_visibility: values.repo_visibility,
                submission_mode: values.submission_mode,
                submission_tags: parseSubmissionTags(values.submission_tags),
                grading:
                  values.grading_choice === "manual"
                    ? {
                        mode: "manual" as const,
                        max_points: values.grading_max_points,
                      }
                    : { mode: values.grading_choice },
                repo_features: formValuesToRepoFeatures(values),
                classroom,
                tests: values.tests,
                test_defaults: formValuesToTestDefaults(values),
                slug: assignment,
              }

              const run = () =>
                editAssignmentMutation.mutateAsync(input, {
                  onSuccess: (result) => onSuccess(result),
                  onError,
                })

              // Confirm when the save changes what students can do or see: a
              // lock transition always, a provisioning-class change only once
              // students already accepted (their repos keep the old setup).
              const impact = editImpactSummary(
                defaultData,
                {
                  empty_repo: values.empty_repo,
                  no_autograder: shape.noAutograder,
                  init_shim: shape.initShim,
                  gradingMode: values.grading_choice,
                  student_permission: values.student_permission || undefined,
                  repo_visibility: values.repo_visibility,
                  locked: values.locked,
                },
                acceptedCount,
              )
              if (impact.length > 0) {
                await new Promise<void>((resolve, reject) => {
                  pendingSubmit.current = {
                    run: async () => {
                      await run()
                    },
                    resolve,
                    reject,
                  }
                  setPendingImpact(impact)
                  setConfirmOpen(true)
                })
                return
              }

              await run()
            }}
          />
          <EditImpactConfirmModal
            open={confirmOpen}
            onClose={closeConfirm}
            onConfirm={() => void confirmSubmit()}
            impact={pendingImpact}
            acceptedCount={acceptedCount}
            saving={editAssignmentMutation.isPending}
          />
        </>
      ) : null}
    </LoadingSwap>
  )
}

export default EditAssignmentForm
