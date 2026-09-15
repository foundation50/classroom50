import { useId } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui"
import { ToggleField } from "@/components/ui"
import type { AssignmentForm } from "../assignmentFormModel"
import {
  dueDateSeed,
  isDeliberatelyCleared,
  releaseDateSeed,
} from "../formFieldHelpers"
import { ReleaseDateAccessNotice } from "./ReleaseDateAccessNotice"
import { SectionCard } from "./SectionCard"

// The schedule pickers, in render order; the form checks them for a half-edited
// entry on submit (that state exists only in the DOM, the model sees "").
export const SCHEDULE_PICKER_FIELDS = [
  "available_from_date",
  "due_date",
] as const
export type SchedulePickerField = (typeof SCHEDULE_PICKER_FIELDS)[number]

// Schedule and access (IA overhaul U8): the opt-in release-date and due-date
// pickers plus the lock toggle. Picker visibility is derived in the
// orchestrator (explicitly opened, or a value is present); the setters here only
// record the explicit open/close.
export function ScheduleSection({
  form,
  org,
  onReset,
  dueDateEnabled,
  setDueDateOpened,
  availableFromEnabled,
  setAvailableFromOpened,
  incompletePicker = null,
}: {
  form: AssignmentForm
  // Org slug; the release-date notice uses it to tell a private in-org
  // template (team read is granted on save) from one it can't affect.
  org?: string
  onReset?: () => void
  dueDateEnabled: boolean
  setDueDateOpened: (opened: boolean) => void
  availableFromEnabled: boolean
  setAvailableFromOpened: (opened: boolean) => void
  // The picker the last submit found half-edited, if any.
  incompletePicker?: SchedulePickerField | null
}) {
  const { t } = useTranslation()
  const incompleteId = useId()
  const tzShort = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value

  const incompleteMessage = (field: SchedulePickerField) =>
    incompletePicker === field ? (
      <p id={`${incompleteId}-${field}`} className="mt-1.5 text-sm text-error">
        {t("assignments.form.validation.scheduleDateIncomplete")}
      </p>
    ) : null

  return (
    <SectionCard
      title={t("assignments.form.scheduleSection")}
      onReset={onReset}
    >
      <div className="flex flex-col gap-4">
        <form.Field name="available_from_date">
          {(field) => (
            <div>
              <ToggleField
                id={`${field.name}-enabled`}
                checked={availableFromEnabled}
                onChange={(checked) => {
                  setAvailableFromOpened(checked)
                  if (!checked) field.handleChange("")
                  else if (!field.state.value)
                    field.handleChange(releaseDateSeed())
                }}
                label={t("assignments.form.setAvailableFrom")}
                help={t("assignments.form.setAvailableFromTip")}
              />
              {availableFromEnabled ? (
                <div className="mt-2 ms-[3.75rem]">
                  <Input
                    id={field.name}
                    name={field.name}
                    type="datetime-local"
                    className="w-full sm:max-w-xs"
                    aria-label={t("assignments.form.availableFrom", {
                      tz: tzShort,
                    })}
                    invalid={incompletePicker === field.name}
                    aria-describedby={
                      incompletePicker === field.name
                        ? `${incompleteId}-${field.name}`
                        : undefined
                    }
                    value={field.state.value}
                    onBlur={(e) => {
                      // Emptying the picker retires the release date: hide it
                      // and uncheck the box (value is already "").
                      if (isDeliberatelyCleared(e.target))
                        setAvailableFromOpened(false)
                      field.handleBlur()
                    }}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  {incompleteMessage(field.name)}
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.availableFromTz", { tz: tzShort })}
                  </p>
                  <ReleaseDateAccessNotice form={form} org={org} />
                </div>
              ) : null}
            </div>
          )}
        </form.Field>

        <form.Field name="due_date">
          {(field) => (
            <div>
              <ToggleField
                id={`${field.name}-enabled`}
                checked={dueDateEnabled}
                onChange={(checked) => {
                  setDueDateOpened(checked)
                  if (!checked) field.handleChange("")
                  else if (!field.state.value) field.handleChange(dueDateSeed())
                }}
                label={t("assignments.form.setDueDate")}
                help={t("assignments.form.setDueDateTip")}
              />
              {dueDateEnabled ? (
                <div className="mt-2 ms-[3.75rem]">
                  <Input
                    id={field.name}
                    name={field.name}
                    type="datetime-local"
                    className="w-full sm:max-w-xs"
                    aria-label={t("assignments.form.dueDate", { tz: tzShort })}
                    invalid={incompletePicker === field.name}
                    aria-describedby={
                      incompletePicker === field.name
                        ? `${incompleteId}-${field.name}`
                        : undefined
                    }
                    value={field.state.value}
                    onBlur={(e) => {
                      // Emptying the picker retires the due date: hide it and
                      // uncheck the box (value is already "").
                      if (isDeliberatelyCleared(e.target))
                        setDueDateOpened(false)
                      field.handleBlur()
                    }}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  {incompleteMessage(field.name)}
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.dueDateTz", { tz: tzShort })}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </form.Field>

        <form.Field name="locked">
          {(field) => (
            <ToggleField
              id={field.name}
              checked={field.state.value}
              onChange={(checked) => field.handleChange(checked)}
              label={t("assignments.form.lockAssignment")}
              help={t("assignments.form.lockAssignmentTip")}
            />
          )}
        </form.Field>
      </div>
    </SectionCard>
  )
}
