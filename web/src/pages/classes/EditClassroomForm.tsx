import { ConfirmModal } from "@/components/modals"
import { ArchivedClassroomNotice } from "@/components/ArchivedClassroomNotice"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useArchiveClassroom } from "@/hooks/mutations/useArchiveClassroom"
import { useDeleteClassroom } from "@/hooks/mutations/useDeleteClassroom"
import { usePurgeInviteTeams } from "@/hooks/mutations/usePurgeInviteTeams"
import { useForm } from "@tanstack/react-form"
import { useNavigate, useParams } from "@tanstack/react-router"
import { TrashIcon } from "@/components/ui/icons"
import { GitHubLink } from "@/components/GitHubLink"
import { classroomConfigTreeUrl } from "@/util/orgUrl"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { focusFirstInvalidField } from "@/util/focusFirstInvalidField"
import { isClassroomArchived, type Classroom } from "@/types/classroom"
import { normalizePagesBaseUrl } from "@/util/pagesBaseUrl"
import { CollapsibleAdvanced } from "@/pages/assignments/sections/CollapsibleAdvanced"
import {
  AnimatedAlert,
  Button,
  Card,
  EmphasisLtr,
  FormField,
  Input,
  Heading,
} from "@/components/ui"

export type EditClassroomFormValues = {
  name: string
  term: string
  // Raw "custom Pages domain" input: a bare domain or a full https base URL;
  // "" = no custom domain. Normalized at submit (see normalizePagesBaseUrl).
  customDomain: string
}

type EditClassroomFormProps = {
  defaultValues?: Partial<EditClassroomFormValues>
  // Receives the values with customDomain already NORMALIZED ("" = clear).
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
        <TrashIcon className="size-4" aria-hidden="true" />
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
  const { announce } = useToast()
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
            // The page state flips in place — SR announcement only.
            announce(
              archived
                ? t("classes.unarchivedToast", { classroom })
                : t("classes.archivedToast", { classroom }),
            )
          } catch (err) {
            // Rethrow with localized copy so the failure surfaces inside the
            // confirm dialog (Primer: dialog errors stay in the dialog).
            throw new Error(
              t(
                archived ? "classes.unarchiveFailed" : "classes.archiveFailed",
                {
                  classroom,
                  error:
                    err instanceof Error
                      ? err.message
                      : t("classes.somethingWentWrong"),
                },
              ),
            )
          }
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

// One-shot cleanup of the classroom's stored invite emails (the hidden
// per-invite teams): recover anything still recoverable into roster.csv, then
// delete the rest. Kept OUTSIDE the archived-disabled fieldset — an archived
// classroom's leftover invite teams are exactly what this exists to clear
// (the automatic reconcile refuses to run there).
const CleanupInviteDataButton = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const [open, setOpen] = useState(false)
  const purgeMutation = usePurgeInviteTeams(org, classroom)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        loading={purgeMutation.isPending}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title={t("classes.inviteCleanup.buttonTitle")}
      >
        {t("classes.inviteCleanup.button")}
      </Button>

      <ConfirmModal
        open={open}
        title={t("classes.inviteCleanup.confirmTitle")}
        description={
          <Trans
            i18nKey="classes.inviteCleanup.body"
            values={{ classroom }}
            components={{
              classroom: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmLabel={t("classes.inviteCleanup.confirm")}
        cancelLabel={t("common.cancel")}
        confirmText=""
        needsConfirm={false}
        dangerous={false}
        onConfirm={async () => {
          try {
            const result = await purgeMutation.mutateAsync()
            // Kept as a toast: the recovered/purged counts aren't evident
            // anywhere in the UI once the dialog closes.
            notify({
              tone: "success",
              durationMs: 6000,
              message: t("classes.inviteCleanup.done", {
                recovered: result.recovered.length,
                purged: result.purged,
              }),
            })
          } catch (err) {
            // Surfaces inside the confirm dialog rather than a corner toast.
            throw new Error(
              t("classes.inviteCleanup.failed", {
                error:
                  err instanceof Error
                    ? err.message
                    : t("classes.somethingWentWrong"),
              }),
            )
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
  // Feedback for an unchanged submit (the button stays enabled per Primer;
  // the submit itself no-ops). Rendered only while still pristine.
  const [noChangesNotice, setNoChangesNotice] = useState(false)
  // Archived = read-only: disable settings fields + Save (Archive/Delete header
  // actions stay live). editClassroom enforces this server-side.
  const archived = isClassroomArchived(cl ?? {})

  const form = useForm({
    defaultValues: {
      name: cl?.name || cl?.short_name || "",
      term: cl?.term || "",
      customDomain: cl?.pages_base_url || "",
    } satisfies EditClassroomFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors: Partial<Record<keyof EditClassroomFormValues, string>> =
          {}
        if (!value.name.trim()) {
          errors.name = t("validation.classroomNameRequired")
        }
        if (normalizePagesBaseUrl(value.customDomain) === null) {
          errors.customDomain = t("validation.customDomainInvalid")
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
        // The validator already rejected a null normalization.
        customDomain: normalizePagesBaseUrl(value.customDomain) ?? "",
      })
      setSubmitted(true)
    },
  })

  if (!org || !classroom) return null

  return (
    <Card
      as="form"
      // noValidate: Primer forms guidance — browser-native validation UI is
      // inaccessible and clashes with our submit-time validation; `required`
      // stays on controls for AT parity.
      noValidate
      bordered={false}
      className="w-full"
      // Any edit clears the unchanged-submit notice — hooked on the DOM
      // events rather than the form model, so controls that sync through
      // local state still clear it.
      onInput={() => setNoChangesNotice(false)}
      onChange={() => setNoChangesNotice(false)}
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        // Unchanged submit: a no-op with feedback — saving identical values
        // would still land a pointless config-repo commit in the audit trail.
        if (form.state.isDefaultValue) {
          setNoChangesNotice(true)
          return
        }
        setNoChangesNotice(false)
        const formEl = e.currentTarget
        void form.handleSubmit().then(() => focusFirstInvalidField(formEl))
      }}
    >
      <Card.Body>
        <div className="flex justify-between">
          <div className="flex items-center gap-3 pb-4">
            <Heading as="h3">{t("classes.form.basicInfo")}</Heading>
            <GitHubLink
              href={classroomConfigTreeUrl(org, classroom)}
              label={t("classes.configRepo")}
              title={t("classes.configRepoTitle")}
            />
          </div>
          <div className="flex items-center gap-2">
            <CleanupInviteDataButton org={org} classroom={classroom} />
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

          {/* Rare, org-level concern (custom Pages domain) — tucked behind the
              shared Advanced disclosure so the common name/term path stays
              uncluttered. */}
          <div className="mb-4">
            <CollapsibleAdvanced>
              <form.Field name="customDomain">
                {(field) => (
                  <FormField
                    label={t("classes.form.customDomain")}
                    htmlFor={field.name}
                    hint={t("classes.form.customDomainHint")}
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
                        dir="ltr"
                        aria-describedby={describedById}
                        invalid={invalid}
                        placeholder={t("classes.form.customDomainPlaceholder")}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    )}
                  </FormField>
                )}
              </form.Field>
            </CollapsibleAdvanced>
          </div>

          {/* Unchanged-submit feedback: a banner directly above the actions,
              cleared by any edit via the form-level onInput/onChange. */}
          <AnimatedAlert tone="info" show={noChangesNotice} className="text-sm">
            {t("classes.form.noChangesToSave")}
          </AnimatedAlert>
          <Card.Actions className="justify-end p-2">
            <form.Subscribe selector={(state) => [state.isSubmitting]}>
              {([isSubmitting]) => (
                <Button
                  type="submit"
                  variant="primary"
                  loading={isSubmitting}
                  loadingLabel={t("classes.form.saving")}
                  // Kept enabled while unchanged or invalid (Primer saving
                  // guidance) — the old disabled-with-tooltip explanation was
                  // unreachable by keyboard. `submitted` still latches after
                  // the save lands (completed state, not a validity gate).
                  disabled={isSubmitting || submitted}
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
