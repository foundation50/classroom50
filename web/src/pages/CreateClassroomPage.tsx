import { useParams, useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { createClassroomFilesWithConflictRetry } from "@/hooks/github/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { GitHubAPIError } from "@/hooks/github/errors"
import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import Breadcrumb from "@/components/breadcrumb"
import MissingParams from "@/components/MissingParams"
import RequireTeacher from "@/components/RequireTeacher"
import CreateClassroomForm from "./classes/CreateClassroomForm"
import { githubKeys } from "@/hooks/github/queries"
import type {
  CreateClassroomInput,
  CreateClassroomResult,
} from "@/api/mutations/classrooms"

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
        switch (err.status) {
          case 409:
            // conflict
            break
          case 404:
            // not found
            break
          case 422:
            // validation
            break
          default:
            // unspecified
            break
        }
      } else {
        console.error("non-GitHub API error:", err)
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
      // Track the publish-pages deploy this commit triggers, anchored on the
      // commit SHA (head_sha on the runs API).
      if (org && result.newCommitSha) {
        register({
          org,
          label: t("actionsBanner.workflow.publishPages"),
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
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 2xl:px-50">
          <Breadcrumb endpoint={t("documentTitle.newClassroom")} />
          <RequireTeacher allow="owner">
            <div className="flex justify-between">
              <div>
                <h1 className="text-xl pt-8 pb-10 font-bold">
                  {t("classes.createTitle")}
                </h1>
              </div>
            </div>
            <div className="flex flex-col">
              <div className="mb-8">
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
              </div>
            </div>
          </RequireTeacher>
        </DrawerContent>
        <DrawerSidebar selected="classes" page="classes" />
      </Drawer>
    </div>
  )
}

export default CreateClassroomPage
