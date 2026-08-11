import { useTranslation } from "react-i18next"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { AdvancedSection } from "../AdvancedSection"
import AutogradingTestsPane from "../AutogradingTestsPane"
import { Alert } from "@/components/ui"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// Autograding: the runtime/setup/allowed-files/threshold Advanced settings and
// Declarative tests. Whether the built-in autograder runs is driven entirely by
// the grading choice in the Submission and Grading section: these controls are
// enabled ONLY when grading is "Autograded" (showBuiltInConfig). For "Manual"
// and "Not graded" the section shows a short note and no config, so a teacher
// can't configure an autograder that will never run.
export function AutogradingSection({
  form,
  status,
  org,
}: {
  form: AssignmentForm
  status: SectionStatus
  org?: string
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.autograding.label")}
      status={status}
    >
      <form.Subscribe
        selector={(state) => deriveFormShape(state.values).showBuiltInConfig}
      >
        {(showBuiltInConfig) =>
          showBuiltInConfig ? (
            <div className="flex flex-col gap-6">
              <AdvancedSection form={form} org={org} />
              <div className="divider my-0" />
              <AutogradingTestsPane form={form} />
            </div>
          ) : (
            <Alert tone="info" role="note" className="text-sm">
              <span>{t("assignments.form.autograding.notAutogradedNote")}</span>
            </Alert>
          )
        }
      </form.Subscribe>
    </SectionCard>
  )
}
