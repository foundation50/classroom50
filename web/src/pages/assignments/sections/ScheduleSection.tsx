import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui"
import { ToggleRow } from "../AdvancedRuntimeFields"
import type { AssignmentForm } from "../assignmentFormModel"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// Schedule (IA overhaul U8): the opt-in release-date and due-date pickers, plus
// the deferred per-student/group Extensions affordance (U9, inert). The toggle
// state lives in the orchestrator so the pickers stay controlled across the
// section split.
export function ScheduleSection({
  form,
  status,
  dueDateEnabled,
  setDueDateEnabled,
  availableFromEnabled,
  setAvailableFromEnabled,
}: {
  form: AssignmentForm
  status: SectionStatus
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
    <SectionCard title={t("assignments.form.scheduleSection")} status={status}>
      <div className="flex flex-col gap-4">
        <form.Field name="available_from_date">
          {(field) => (
            <div>
              <ToggleRow
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
              <ToggleRow
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

        {/* Deferred (R14/U9): per-student/group due-date extensions. Reserved
            as an inert, disabled affordance — there is no due-override data
            model yet, so it writes nothing to assignments.json. */}
        <div className="pointer-events-none opacity-50" aria-disabled="true">
          <ToggleRow
            id="extensions-deferred"
            checked={false}
            onChange={() => {}}
            label={t("assignments.form.extensions.label")}
            help={t("assignments.form.extensions.help")}
          />
        </div>
      </div>
    </SectionCard>
  )
}
