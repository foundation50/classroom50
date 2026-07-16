import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { Spinner } from "@/components/Spinner"
import { useParams } from "@tanstack/react-router"
import EditClassroomForm from "./classes/EditClassroomForm"
import ClassroomStaffSection from "./classes/ClassroomStaffSection"
import { GitHubAPIError } from "@/github-core/errors"
import useGetClassroom from "@/hooks/useGetClassroom"
import { useTranslation } from "react-i18next"
import { useEditClassroom } from "@/hooks/mutations/useEditClassroom"
import { isClassroomArchived } from "@/types/classroom"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import RequireRole from "@/components/RequireRole"
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
  const { notify } = useToast()
  const { register } = useActionActivityRegistry()
  const runSave = useSafeSubmit()
  const { data: cl, isLoading: loadingClassroom } = useGetClassroom(
    org,
    classroom,
  )

  const editClassroomMutation = useEditClassroom(org, classroom, (result) => {
    // A classroom.json write triggers a publish-pages deploy — surface it in
    // the global activity banner, anchored on the commit SHA.
    if (result?.newCommitSha) {
      register({
        org,
        label: t("actionsBanner.workflow.publishClassroom", {
          name: cl?.name ?? classroom,
        }),
        anchor: { kind: "sha", sha: result.newCommitSha },
      })
    }
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
                editClassroomMutation.mutateAsync(
                  {
                    name: values.name,
                    slug: classroom,
                    org,
                    term: values.term,
                  },
                  {
                    onError: (err) => {
                      notify({
                        tone: "error",
                        message:
                          err instanceof GitHubAPIError && err.status === 409
                            ? t("toasts.classroomSaveConflict")
                            : t("toasts.classroomSaveFailed", {
                                message: err.message,
                              }),
                      })
                    },
                    onSuccess: () => {
                      // Plain-text message only: NotificationProvider is mounted
                      // ABOVE the RouterProvider, so a TanStack <Link> here has
                      // no router context and throws on render, blanking the
                      // app. Settings update in place via the hook's
                      // invalidations, so no navigation link is needed.
                      notify({
                        tone: "success",
                        durationMs: 5000,
                        message: t("toasts.classroomSettingsSaved"),
                      })
                    },
                  },
                ),
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
      <RequireRole allow="instructor">
        {!org || !classroom ? (
          <MissingParams message={t("classes.missingOrgOrClassroom")} />
        ) : (
          <EditClassroomContent org={org} classroom={classroom} />
        )}
      </RequireRole>
    </PageShell>
  )
}

export default EditClassroomPage
