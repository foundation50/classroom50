import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"

import Breadcrumb from "@/components/breadcrumb"
import MissingParams from "@/components/MissingParams"
import RequireTeacher from "@/components/RequireTeacher"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import CreateAssignmentForm from "@/pages/assignments/CreateAssignmentForm"
import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { GitHubAPIError } from "@/hooks/github/errors"
import { createAssignment } from "@/hooks/github/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { githubKeys } from "@/hooks/github/queries"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type {
  CreateAssignmentInput,
  CreateAssignmentResult,
} from "@/api/mutations/assignments"

const CreateAssignmentPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.newAssignment"))
  const client = useGitHubClient()
  const navigate = useNavigate()
  const { org, classroom } = useParams({ strict: false })
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const { register } = useActionActivityRegistry()
  const [errorMessage, setErrorMessage] = useState("")
  const [warningMessage, setWarningMessage] = useState("")

  const { data: assignmentsData } = useGetClassroomAssignments(org, classroom)
  const takenSlugs = (assignmentsData?.assignments ?? []).map((a) => a.slug)

  const emptyRoster = useEmptyRosterWarning(org, classroom)

  const createClassroomMutation = useMutation<
    CreateAssignmentResult,
    GitHubAPIError,
    CreateAssignmentInput
  >({
    mutationFn: (input) => createAssignment(client, input),
    onError: (err) => {
      if (err instanceof GitHubAPIError) {
        switch (err.status) {
          case 409:
            break
          case 404:
            break
          case 422:
            break
          default:
            break
        }
      } else {
        console.error("non-GitHub API error:", err)
      }
      setErrorMessage(err.message)
      window.scrollTo({ top: 0, behavior: "smooth" })
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org ?? "",
          "classroom50",
          `${classroom ?? ""}/assignments.json`,
        ),
      })
      // Track the publish-pages deploy this commit triggers, anchored on SHA.
      if (org && result.newCommitSha) {
        register({
          org,
          label: t("toasts.publishingAssignment", { name: variables.name }),
          anchor: { kind: "sha", sha: result.newCommitSha },
        })
      }
      // If the template team grant failed, stay on the page to show the warning
      // instead of navigating away.
      if (result.templateGrantWarning) {
        setWarningMessage(result.templateGrantWarning)
        window.scrollTo({ top: 0, behavior: "smooth" })
        return
      }
      // Toast before navigating: the provider is mounted above the router, so
      // the confirmation survives the redirect.
      notify({
        tone: "success",
        durationMs: 6000,
        message: t("toasts.assignmentCreated"),
      })
      navigate({
        to: "/$org/$classroom/assignments/$assignment",
        params: {
          org: org ?? "",
          classroom: classroom ?? "",
          assignment: variables.slug,
        },
      })
    },
  })

  if (!org || !classroom) {
    return <MissingParams message={t("assignments.missingOrgOrClassroom")} />
  }
  return (
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 2xl:px-50">
          <Breadcrumb endpoint={t("assignments.createBreadcrumb")} />
          <RequireTeacher>
            <div className="flex justify-between">
              <div>
                <h1 className="text-xl pt-8 pb-10 font-bold">
                  {t("assignments.createHeading")}
                </h1>
              </div>
            </div>
            {emptyRoster.show ? (
              <EmptyRosterNotice
                org={org}
                classroom={classroom}
                hasRosterRows={emptyRoster.hasRosterRows}
              />
            ) : null}
            {errorMessage ? (
              <div className="alert alert-error mb-6">{errorMessage}</div>
            ) : (
              <></>
            )}
            {warningMessage ? (
              <div className="alert alert-warning mb-6 flex flex-col items-start gap-2">
                <span>{warningMessage}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    navigate({
                      to: "/$org/$classroom/assignments",
                      params: { org, classroom },
                    })
                  }
                >
                  {t("assignments.goToAssignments")}
                </button>
              </div>
            ) : (
              <></>
            )}
            <div className="flex flex-col">
              <div className="mb-8">
                <CreateAssignmentForm
                  loading={createClassroomMutation.isPending}
                  org={org}
                  classroom={classroom}
                  takenSlugs={takenSlugs}
                  onSubmit={(values) => {
                    setErrorMessage("")
                    setWarningMessage("")
                    createClassroomMutation.mutateAsync({
                      name: values.name,
                      slug: values.slug,
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
                    })
                  }}
                />
              </div>
            </div>
          </RequireTeacher>
        </DrawerContent>
        <DrawerSidebar selected="assignments" />
      </Drawer>
    </div>
  )
}

export default CreateAssignmentPage
