import { ConfirmModal } from "@/components/modals"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useArchiveClassroom } from "@/hooks/mutations/useArchiveClassroom"
import { useDeleteClassroom } from "@/hooks/mutations/useDeleteClassroom"
import { useForm } from "@tanstack/react-form"
import { useNavigate, useParams } from "@tanstack/react-router"
import { Trash2 } from "lucide-react"
import { GitHubLink } from "@/components/GitHubLink"
import { classroomConfigTreeUrl } from "@/util/orgUrl"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { isClassroomArchived, type Classroom } from "@/types/classroom"
import { Button, Card, EmphasisLtr, FormField, Input } from "@/components/ui"

export type EditClassroomFormValues = {
  name: string
  term: string
}

type EditClassroomFormProps = {
  defaultValues?: Partial<EditClassroomFormValues>
  onSubmit: (values: EditClassroomFormValues) => void | Promise<void>
  cl?: Classroom
}

export const DeleteClassroomButton = ({
  org,
  classroom,
  onDeleteClassroom,
}: {
  org: string
  classroom: string
  onDeleteClassroom: () => void
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const [open, setOpen] = useState(false)
  const deleteClassroomMutation = useDeleteClassroom(org, classroom)

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
          <Trans
            i18nKey="classes.deleteClassroomBody"
            values={{ classroom, org }}
            components={{
              classroom: <EmphasisLtr className="text-base-content" />,
              org: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmText={`${org}/${classroom}`}
        confirmLabel={t("classes.deleteClassroomConfirm")}
        cancelLabel={t("classes.deleteClassroomCancel")}
        dangerous
        onConfirm={async () => {
          const result = await deleteClassroomMutation.mutateAsync({
            org,
            classroom,
          })
          // Surface the non-fatal team-cleanup warning (the classroom dir was
          // still deleted); the toast rides along to the destination page.
          if (result.teamDeleteWarning) {
            notify({
              tone: "warning",
              message: t("classes.deleteTeamWarning", { classroom }),
            })
          }
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
  const { notify } = useToast()
  const [open, setOpen] = useState(false)

  // A pure archive/unarchive write: editClassroom preserves name/term when
  // omitted, so we send only `active`. The hook owns the optimistic flip +
  // rollback + list invalidation; the success/error toasts stay at the call
  // site below.
  const archiveMutation = useArchiveClassroom(org, classroom)

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
        {archived ? <>{t("classes.unarchive")}</> : <>{t("classes.archive")}</>}
      </Button>

      <ConfirmModal
        open={open}
        title={
          archived
            ? t("classes.unarchiveConfirmTitle")
            : t("classes.archiveConfirmTitle")
        }
        description={
          <Trans
            i18nKey={archived ? "classes.unarchiveBody" : "classes.archiveBody"}
            values={{ classroom }}
            components={{
              classroom: <EmphasisLtr className="text-base-content" />,
            }}
          />
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
                // Cache reconcile is owned by useDeleteClassroom; call site only
                // navigates.
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
