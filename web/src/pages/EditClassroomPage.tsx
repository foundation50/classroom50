import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
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
import { Alert } from "@/components/ui"

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
      // the global activity banner, anchored on the commit SHA.
      if (org && result?.newCommitSha) {
        register({
          org,
          label: t("actionsBanner.workflow.publishClassroom", {
            name: cl?.name ?? classroom,
          }),
          anchor: { kind: "sha", sha: result.newCommitSha },
        })
      }
      // Plain-text message only: NotificationProvider is mounted ABOVE the
      // RouterProvider, so a TanStack <Link> here has no router context and
      // throws on render, blanking the app. Settings update in place via the
      // invalidations above, so no navigation link is needed.
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
        <Alert tone="error">{t("classes.couldNotLoad")}</Alert>
      ) : (
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t("documentTitle.classroomSettings")}
            subtitle={
              <>
                {t("classes.settingsSubtitle_prefix")}{" "}
                <span className="font-semibold">
                  {cl.name || cl.short_name || classroom}
                </span>{" "}
                {t("classes.settingsSubtitle_suffix")}
              </>
            }
          />
          <EditClassroomForm
            cl={cl}
            onSubmit={(values) =>
              runSave(() =>
                editClassroomMutation.mutateAsync({
                  name: values.name,
                  slug: classroom,
                  org,
                  term: values.term,
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
      )}
    </LoadingSwap>
  )
}

const EditClassroomPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.classroomSettings"))
  const { org, classroom } = useParams({ strict: false })

  return (
    <PageShell selected="settings">
      <Breadcrumb endpoint={t("nav.settings")} />
      <RequireTeacher allow="instructor">
        {!org || !classroom ? (
          <MissingParams message={t("classes.missingOrgOrClassroom")} />
        ) : (
          <EditClassroomContent org={org} classroom={classroom} />
        )}
      </RequireTeacher>
    </PageShell>
  )
}

export default EditClassroomPage
