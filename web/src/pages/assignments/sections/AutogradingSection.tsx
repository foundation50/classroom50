import { useTranslation } from "react-i18next"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { AdvancedSection } from "../AdvancedSection"
import AutogradingTestsPane from "../AutogradingTestsPane"
import { AutogradingStateField } from "./AutogradingStateField"
import { Alert } from "@/components/ui"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// Autograding: the built-in-autograder toggle plus the runtime/setup/allowed-
// files/threshold Advanced settings and Declarative tests. Configuration is
// OFFERED only when grading is "Autograded" in the Submission and Grading
// section (showAutogradingConfig) — for "Manual" and "Not graded" the section
// shows a short note and no config, so a teacher can't configure an autograder
// that will never run. Within Autograded, the built-in autograder is opt-in
// (default off); the Advanced + Tests panes render only when it's on
// (showBuiltInConfig).
export function AutogradingSection({
  form,
  status,
  org,
  edit = false,
}: {
  form: AssignmentForm
  status: SectionStatus
  org?: string
  // On edit the built-in choice is locked (it maps to no_autograder/init_shim,
  // which the domain layer refuses to change after creation).
  edit?: boolean
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.autograding.label")}
      status={status}
    >
      <form.Subscribe selector={(state) => deriveFormShape(state.values)}>
        {(shape) =>
          !shape.showAutogradingConfig ? (
            <Alert tone="info" role="note" className="text-sm">
              <span>{t("assignments.form.autograding.notAutogradedNote")}</span>
            </Alert>
          ) : (
            <div className="flex flex-col gap-6">
              <AutogradingStateField form={form} edit={edit} />
              {shape.showBuiltInConfig ? (
                <>
                  <div className="divider my-0" />
                  <AdvancedSection form={form} org={org} />
                  <div className="divider my-0" />
                  <AutogradingTestsPane form={form} />
                </>
              ) : null}
            </div>
          )
        }
      </form.Subscribe>
    </SectionCard>
  )
}
