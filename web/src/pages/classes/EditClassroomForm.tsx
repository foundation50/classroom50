import {
  deleteClassroom,
  editClassroomWithConflictRetry,
  type DeleteClassroomInput,
} from "@/domain/classrooms"
import { ConfirmModal } from "@/components/modals"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { Archive, ArchiveRestore, Trash2 } from "lucide-react"
import { GitHubLink } from "@/components/GitHubLink"
import { classroomConfigTreeUrl } from "@/util/orgUrl"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { isClassroomArchived, type Classroom } from "@/types/classroom"
import { Button, Card, FormField, Input } from "@/components/ui"

export type EditClassroomFormValues = {
  name: string
  term: string
}

type EditClassroomFormProps = {
  defaultValues?: Partial<EditClassroomFormValues>
  onSubmit: (values: EditClassroomFormValues) => void | Promise<void>
  cl?: Classroom
}

const DeleteClassroomButton = ({
  org,
  classroom,
  onDeleteClassroom,
}: {
  org: string
  classroom: string
  onDeleteClassroom: () => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const [open, setOpen] = useState(false)
  const deleteClassroomMutation = useMutation({
    mutationFn: (input: DeleteClassroomInput) => deleteClassroom(client, input),
    onSuccess: () => onDeleteClassroom(),
  })

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="text-error"
        aria-label={t("classes.deleteClassroomAria")}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>

      <ConfirmModal
        open={open}
        title={t("classes.deleteClassroomTitle")}
        description={
          <>
            {t("classes.deleteClassroomBody_1")}{" "}
            <span className="font-semibold text-base-content">{classroom}</span>{" "}
            {t("classes.deleteClassroomBody_2")}{" "}
            <span className="font-semibold text-base-content">{org}</span>{" "}
            {t("classes.deleteClassroomBody_3")}
          </>
        }
        confirmText={`${org}/${classroom}`}
        confirmLabel={t("classes.deleteClassroomConfirm")}
        cancelLabel={t("classes.deleteClassroomCancel")}
        dangerous
        onConfirm={async () => {
          await deleteClassroomMutation.mutateAsync({
            org,
            classroom,
          })
          onDeleteClassroom()
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

// Archive / unarchive toggles the classroom's `active` flag (false = archived)
// via the conflict-retried edit, immediately (not through Save), toasting the
// result. Archived classrooms drop out of the default list and refuse new
// assignments/accepts.
const ArchiveClassroomButton = ({
  org,
  classroom,
  archived,
}: {
  org: string
  classroom: string
  // Current lifecycle state, so the button shows the opposite action.
  archived: boolean
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  // A pure archive/unarchive write: editClassroom preserves name/term when
  // omitted, so we send only `active` — no refetch, no stale name/term.
  const archiveMutation = useMutation({
    mutationFn: (active: boolean) =>
      editClassroomWithConflictRetry(client, {
        org,
        slug: classroom,
        active,
      }),
    onSuccess: (_result, active) => {
      // Optimistically flip the cached classroom.json `active` so the button,
      // read-only fieldset, and badges update immediately. GitHub's contents API
      // is read-after-write eventual, so we do NOT invalidate this exact key: an
      // immediate refetch can read the pre-write body and clobber the optimistic
      // flip. The optimistic value stays authoritative; the staleTime refetch
      // reconciles later.
      const key = githubKeys.jsonFile(
        org,
        CONFIG_REPO,
        `${classroom}/classroom.json`,
      )
      queryClient.setQueryData(
        key,
        (prev: Record<string, unknown> | undefined) =>
          prev ? { ...prev, active } : prev,
      )
      // Repartition the classes list (Active/Archived/All) — a different query
      // than the per-classroom classroom.json above.
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
      })
    },
  })

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title={
          archived ? t("classes.unarchiveTitle") : t("classes.archiveTitle")
        }
      >
        {archived ? (
          <>
            <ArchiveRestore aria-hidden="true" className="size-4" />{" "}
            {t("classes.unarchive")}
          </>
        ) : (
          <>
            <Archive aria-hidden="true" className="size-4" />{" "}
            {t("classes.archive")}
          </>
        )}
      </Button>

      <ConfirmModal
        open={open}
        title={
          archived
            ? t("classes.unarchiveConfirmTitle")
            : t("classes.archiveConfirmTitle")
        }
        description={
          archived ? (
            <>
              {t("classes.unarchiveBody_prefix")}{" "}
              <span className="font-semibold text-base-content">
                {classroom}
              </span>{" "}
              {t("classes.unarchiveBody_suffix")}
            </>
          ) : (
            <>
              {t("classes.archiveBody_prefix")}{" "}
              <span className="font-semibold text-base-content">
                {classroom}
              </span>
              {t("classes.archiveBody_suffix")}
            </>
          )
        }
        confirmLabel={archived ? t("classes.unarchive") : t("classes.archive")}
        cancelLabel={t("common.cancel")}
        confirmText=""
        needsConfirm={false}
        dangerous={false}
        onConfirm={async () => {
          try {
            await archiveMutation.mutateAsync(archived)
            notify({
              tone: "success",
              durationMs: 5000,
              message: archived
                ? t("classes.unarchivedToast", { classroom })
                : t("classes.archivedToast", { classroom }),
            })
          } catch (err) {
            notify({
              tone: "error",
              message: archived
                ? t("classes.unarchiveFailed", {
                    classroom,
                    error:
                      err instanceof Error
                        ? err.message
                        : t("classes.somethingWentWrong"),
                  })
                : t("classes.archiveFailed", {
                    classroom,
                    error:
                      err instanceof Error
                        ? err.message
                        : t("classes.somethingWentWrong"),
                  }),
            })
          }
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

const EditClassroomForm = ({ onSubmit, cl }: EditClassroomFormProps) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { org, classroom } = useParams({ strict: false })
  const [submitted, setSubmitted] = useState(false)
  // Archived = read-only: disable settings fields + Save (Archive/Delete header
  // actions stay live). editClassroom enforces this server-side.
  const archived = isClassroomArchived(cl ?? {})

  const form = useForm({
    defaultValues: {
      name: cl?.name || cl?.short_name || "",
      term: cl?.term || "",
    } satisfies EditClassroomFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors: Partial<Record<keyof EditClassroomFormValues, string>> =
          {}
        if (!value.name.trim()) {
          errors.name = t("validation.classroomNameRequired")
        }

        return Object.keys(errors).length > 0
          ? {
              fields: errors,
            }
          : undefined
      },
    },
    onSubmit: async ({ value }) => {
      await onSubmit({
        name: value.name.trim(),
        term: value.term.trim(),
      })
      setSubmitted(true)
    },
  })

  if (!org || !classroom) return null

  return (
    <Card
      as="form"
      bordered={false}
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
    >
      <Card.Body>
        <div className="flex justify-between">
          <div className="flex items-center gap-3 pb-4">
            <h3 className="text-lg font-bold">{t("classes.form.basicInfo")}</h3>
            <GitHubLink
              href={classroomConfigTreeUrl(org, classroom)}
              label={t("classes.configRepo")}
              title={t("classes.configRepoTitle")}
            />
          </div>
          <div className="flex items-center gap-2">
            <ArchiveClassroomButton
              org={org}
              classroom={classroom}
              archived={archived}
            />
            <DeleteClassroomButton
              org={org}
              classroom={classroom}
              onDeleteClassroom={() => {
                queryClient.invalidateQueries({
                  queryKey: githubKeys.jsonFile(org, CONFIG_REPO),
                })
                navigate({ to: "/$org", params: { org } })
              }}
            />
          </div>
        </div>

        {archived ? (
          <ArchivedClassroomNotice className="mb-2">
            {t("classes.archivedReadOnlyNotice")}
          </ArchivedClassroomNotice>
        ) : null}

        <fieldset disabled={archived} className="m-0 min-w-0 border-0 p-0">
          <form.Field name="name">
            {(field) => (
              <FormField
                label={t("classes.form.name")}
                htmlFor={field.name}
                required
                error={
                  field.state.meta.errors.length > 0
                    ? field.state.meta.errors[0]
                    : undefined
                }
                className="mb-4"
              >
                {({ id, describedById, invalid }) => (
                  <Input
                    id={id}
                    name={field.name}
                    required
                    aria-required="true"
                    aria-describedby={describedById}
                    invalid={invalid}
                    placeholder={t("classes.form.namePlaceholder")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                )}
              </FormField>
            )}
          </form.Field>

          <FormField
            label={t("classes.form.slug")}
            htmlFor="classroom-slug-display"
            required
            className="mb-4"
          >
            {({ id }) => (
              <Input
                id={id}
                disabled
                placeholder={t("classes.form.slugPlaceholder")}
                value={classroom}
              />
            )}
          </FormField>

          <form.Field name="term">
            {(field) => (
              <FormField
                label={t("classes.form.term")}
                htmlFor={field.name}
                error={
                  field.state.meta.errors.length > 0
                    ? field.state.meta.errors[0]
                    : undefined
                }
                className="mb-4"
              >
                {({ id, describedById, invalid }) => (
                  <Input
                    id={id}
                    name={field.name}
                    aria-describedby={describedById}
                    invalid={invalid}
                    placeholder={t("classes.form.termPlaceholder")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                )}
              </FormField>
            )}
          </form.Field>

          <Card.Actions className="justify-end p-2">
            <form.Subscribe
              selector={(state) => [
                state.canSubmit,
                state.isSubmitting,
                state.isDefaultValue,
              ]}
            >
              {([canSubmit, isSubmitting, isDefaultValue]) => (
                <Button
                  type="submit"
                  variant="primary"
                  loading={isSubmitting}
                  loadingLabel={t("classes.form.saving")}
                  disabled={
                    !canSubmit || isSubmitting || submitted || isDefaultValue
                  }
                  title={
                    isDefaultValue
                      ? t("classes.form.noChangesToSave")
                      : undefined
                  }
                >
                  {isSubmitting
                    ? t("classes.form.saving")
                    : t("classes.form.saveButton")}
                </Button>
              )}
            </form.Subscribe>
          </Card.Actions>
        </fieldset>
      </Card.Body>
    </Card>
  )
}

export default EditClassroomForm
