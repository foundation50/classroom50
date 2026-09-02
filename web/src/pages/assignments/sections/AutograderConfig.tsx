import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { AdvancedSection } from "../AdvancedSection"
import AutogradingTestsPane from "../AutogradingTestsPane"
import { AutogradingStateField } from "./AutogradingStateField"

// The autograder configuration, rendered inside the Submission and grading
// section only when grading is "Autograded". It offers the built-in-autograder
// choice (built-in first and default); when built-in is on, the collapsible
// tests list comes first and the runtime/setup/allowed-files/threshold Advanced
// settings collapse below it (showBuiltInConfig). The parent gates the whole
// block on showAutogradingConfig, so a teacher can't configure an autograder
// that will never run.
export function AutograderConfig({
  form,
  org,
  classroom,
  slug,
  edit = false,
  hasAcceptedStudents = false,
}: {
  form: AssignmentForm
  org?: string
  classroom?: string
  slug?: string
  // Threaded to AutogradingStateField's edit caveat.
  edit?: boolean
  hasAcceptedStudents?: boolean
}) {
  return (
    <form.Subscribe
      selector={(state) => deriveFormShape(state.values).showBuiltInConfig}
    >
      {(showBuiltInConfig) => (
        <div className="flex flex-col gap-4">
          <AutogradingStateField
            form={form}
            edit={edit}
            hasAcceptedStudents={hasAcceptedStudents}
          />
          {showBuiltInConfig ? (
            <>
              <AutogradingTestsPane
                form={form}
                org={org}
                classroom={classroom}
                slug={slug}
              />
              <AdvancedSection form={form} org={org} />
            </>
          ) : null}
        </div>
      )}
    </form.Subscribe>
  )
}
