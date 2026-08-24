import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui"
import { ToggleField } from "@/components/ui"
import type { AssignmentForm } from "../assignmentFormModel"
import { SectionCard } from "./SectionCard"

// Schedule (IA overhaul U8): the opt-in release-date and due-date pickers. The
// toggle state lives in the orchestrator so the pickers stay controlled across
// the section split.
export function ScheduleSection({
  form,
  onReset,
  dueDateEnabled,
  setDueDateEnabled,
  availableFromEnabled,
  setAvailableFromEnabled,
}: {
  form: AssignmentForm
  onReset?: () => void
  dueDateEnabled: boolean
  setDueDateEnabled: (enabled: boolean) => void
  availableFromEnabled: boolean
  setAvailableFromEnabled: (enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const tzShort = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value

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
                  setAvailableFromEnabled(checked)
                  if (!checked) field.handleChange("")
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
                    value={field.state.value}
                    onBlur={(e) => {
                      // Clearing the picker retires the release date: hide it
                      // and uncheck the box (value is already "").
                      if (!e.target.value) setAvailableFromEnabled(false)
                      field.handleBlur()
                    }}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.availableFromTz", { tz: tzShort })}
                  </p>
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
                  setDueDateEnabled(checked)
                  if (!checked) field.handleChange("")
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
                    value={field.state.value}
                    onBlur={(e) => {
                      // Clearing the picker retires the due date: hide it and
                      // uncheck the box (value is already "").
                      if (!e.target.value) setDueDateEnabled(false)
                      field.handleBlur()
                    }}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.dueDateTz", { tz: tzShort })}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </form.Field>
      </div>
    </SectionCard>
  )
}
