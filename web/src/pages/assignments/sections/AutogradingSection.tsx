import { useTranslation } from "react-i18next"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { AdvancedSection } from "../AdvancedSection"
import AutogradingTestsPane from "../AutogradingTestsPane"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"
import { AutogradingStateField } from "./AutogradingStateField"

// Autograding (IA overhaul U7): the tri-state selector plus, when the built-in
// autograder is selected, its sub-controls — Advanced settings
// (runtime/setup/allowed-files/threshold) and Declarative tests. The submission
// trigger + milestone tags moved to their own Submission and Grading section.
// Everything below the selector is gated on showBuiltInConfig so "empty" and
// "none" (both no-shim) show no grading config.
export function AutogradingSection({
  form,
  edit,
  status,
  org,
}: {
  form: AssignmentForm
  edit: boolean
  status: SectionStatus
  org?: string
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.autograding.label")}
      status={status}
    >
      <AutogradingStateField form={form} edit={edit} />

      {/* Built-in sub-controls: Advanced and Declarative tests. Hidden for a
          bare repo (no shim) and for teacher-supplied CI ("none"); empty_repo
          always wins over a stale tri-state value via deriveFormShape. */}
      <form.Subscribe
        selector={(state) => deriveFormShape(state.values).showBuiltInConfig}
      >
        {(showBuiltInConfig) =>
          showBuiltInConfig ? (
            <div className="mt-6 flex flex-col gap-6">
              <AdvancedSection form={form} org={org} />
              <div className="divider my-0" />
              <AutogradingTestsPane form={form} />
            </div>
          ) : null
        }
      </form.Subscribe>
    </SectionCard>
  )
}
