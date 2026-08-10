import { useTranslation } from "react-i18next"
import { Alert, FormField } from "@/components/ui"
import type { AssignmentForm } from "./assignmentFormModel"
import type { AutogradingState } from "@/domain/assignments/autogradingState"

// The autograding tri-state selector (assignment-form IA overhaul U3/U7).
// A single radio group over the three states:
//   - empty     : bare repo, no shim — driven by the repository source choice,
//                 so it renders read-only here with an inline explanation that
//                 points back to Repository Setup (a teacher changes it there,
//                 not here).
//   - none      : templated, teacher-supplied CI — no built-in shim; the
//                 teacher's own .github/ runs. Maps to no_autograder on the wire.
//   - built-in  : the default-shim path; reveals triggers / advanced / tests
//                 (gated by the caller on autograding_state === "built-in").
// Wired to the form's UI-only autograding_state; the submit mapping in
// toSubmitValues translates it to the wire fields (no_autograder + clears).
const SELECTABLE: readonly AutogradingState[] = ["built-in", "none"]

export function AutogradingSection({ form }: { form: AssignmentForm }) {
  const { t } = useTranslation()

  return (
    <form.Field name="autograding_state">
      {(field) => {
        const isEmpty = field.state.value === "empty"
        return (
          <FormField
            htmlFor={field.name}
            label={t("assignments.form.autograding.label")}
          >
            {({ describedById }) => (
              <div aria-describedby={describedById}>
                {isEmpty ? (
                  // Driven by the empty-repo source choice; not editable here.
                  <Alert tone="info" role="status" className="text-sm">
                    <span>
                      {t("assignments.form.autograding.emptyExplain")}
                    </span>
                  </Alert>
                ) : (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">
                      {t("assignments.form.autograding.label")}
                    </legend>
                    {SELECTABLE.map((option) => (
                      <label
                        key={option}
                        htmlFor={`${field.name}-${option}`}
                        className="label cursor-pointer items-start justify-start gap-3 p-0"
                      >
                        <input
                          id={`${field.name}-${option}`}
                          type="radio"
                          className="radio mt-1"
                          name={field.name}
                          value={option}
                          checked={field.state.value === option}
                          onBlur={field.handleBlur}
                          onChange={() => field.handleChange(option)}
                        />
                        <span className="font-bold">
                          {t(
                            `assignments.form.autograding.choices.${option}.label`,
                          )}
                          <span className="mt-0.5 block font-normal text-sm text-base-content/70">
                            {t(
                              `assignments.form.autograding.choices.${option}.help`,
                            )}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            )}
          </FormField>
        )
      }}
    </form.Field>
  )
}

export default AutogradingSection
