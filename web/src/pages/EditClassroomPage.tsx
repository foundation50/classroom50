import Breadcrumb from "@/components/breadcrumb"
import MissingParams from "@/components/MissingParams"
import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { Spinner } from "@/components/Spinner"
import { useParams } from "@tanstack/react-router"
import EditClassroomForm from "./classes/EditClassroomForm"
import ClassroomStaffSection from "./classes/ClassroomStaffSection"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { GitHubAPIError } from "@/hooks/github/errors"
import { githubKeys } from "@/hooks/github/queries"
import useGetClassroom from "@/hooks/useGetClassroom"
import { useTranslation } from "react-i18next"
import {
  type EditClassroomInput,
  type EditClassroomResult,
} from "@/hooks/github/mutations"
import { editClassroomWithConflictRetry } from "@/api/mutations/classrooms"
import { isClassroomArchived } from "@/types/classroom"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import RequireTeacher from "@/components/RequireTeacher"
import { LoadingSwap } from "@/lib/LoadingSwap"

const EditClassroomContent = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const { register } = useActionActivityRegistry()
  const runSave = useSafeSubmit()
  const { data: cl, isLoading: loadingClassroom } = useGetClassroom(
    org,
    classroom,
  )

  const editClassroomMutation = useMutation<
    EditClassroomResult,
    GitHubAPIError,
    EditClassroomInput
  >({
    mutationFn: (input) => editClassroomWithConflictRetry(client, input),
    onError: (err) => {
      notify({
        tone: "error",
        message:
          err instanceof GitHubAPIError && err.status === 409
            ? t("toasts.classroomSaveConflict")
            : t("toasts.classroomSaveFailed", { message: err.message }),
      })
    },
    onSuccess: (result) => {
      // Refresh the exact classroom.json query useGetClassroom reads (so a
      // renamed name/term updates in place), plus the classes-list listing.
      // A bare rawFile("/") key matched no live query — useGetClassroom keys on
      // jsonFile(org,"classroom50",`${classroom}/classroom.json`).
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org ?? "",
          "classroom50",
          `${classroom}/classroom.json`,
        ),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org ?? "", "classroom50"),
      })
      // A classroom.json write triggers a publish-pages deploy — surface it in
      // the global activity banner, anchored on the commit SHA (head_sha).
      if (org && result?.newCommitSha) {
        register({
          org,
          label: t("actionsBanner.workflow.publishPages"),
          anchor: { kind: "sha", sha: result.newCommitSha },
        })
      }
      // Plain-text message only: the toast surface (NotificationProvider) is
      // mounted ABOVE the RouterProvider, so a TanStack <Link> here has no
      // router context and throws on render, blanking the whole app (the throw
      // escapes the route-level errorComponent). The settings already update in
      // place via the invalidations above, so no navigation link is needed.
      notify({
        tone: "success",
        durationMs: 5000,
        message: t("toasts.classroomSettingsSaved"),
      })
    },
  })

  return (
    <LoadingSwap
      loading={loadingClassroom}
      fallback={
        <div className="flex">
          <Spinner className="m-auto" label={t("classes.loadingClassroom")} />
        </div>
      }
    >
      {!cl ? (
        <div className="alert alert-error">{t("classes.couldNotLoad")}</div>
      ) : (
        <>
          <div className="flex justify-between">
            <div>
              <h1 className="text-xl pt-8 pb-2 font-bold">
                {t("documentTitle.classroomSettings")}
              </h1>
              <p className="pb-10 text-sm text-base-content/70">
                {t("classes.settingsSubtitle_prefix")}{" "}
                <span className="font-semibold">
                  {cl.name || cl.short_name || classroom}
                </span>{" "}
                {t("classes.settingsSubtitle_suffix")}
              </p>
            </div>
          </div>
          <div className="flex flex-col">
            <div className="mb-8">
              <EditClassroomForm
                cl={cl}
                onSubmit={(values) =>
                  runSave(() =>
                    editClassroomMutation.mutateAsync({
                      name: values.name,
                      slug: classroom,
                      org,
                      term: values.term,
                      onboarding_cleanup: values.onboarding_cleanup,
                    }),
                  )
                }
              />
              <ClassroomStaffSection
                org={org}
                classroom={classroom}
                disabled={isClassroomArchived(cl)}
              />
            </div>
          </div>
        </>
      )}
    </LoadingSwap>
  )
}

const EditClassroomPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.classroomSettings"))
  const { org, classroom } = useParams({ strict: false })

  return (
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 2xl:px-50">
          <Breadcrumb endpoint={t("nav.settings")} />
          <RequireTeacher allow="instructor">
            {!org || !classroom ? (
              <MissingParams message={t("classes.missingOrgOrClassroom")} />
            ) : (
              <EditClassroomContent org={org} classroom={classroom} />
            )}
          </RequireTeacher>
        </DrawerContent>
        <DrawerSidebar selected="settings" />
      </Drawer>
    </div>
  )
}

export default EditClassroomPage
