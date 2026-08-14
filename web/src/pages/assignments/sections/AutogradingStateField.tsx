import { useTranslation } from "react-i18next"
import { Alert, FormField } from "@/components/ui"
import type { AssignmentForm } from "../assignmentFormModel"
import type { AutogradingState } from "@/domain/assignments/autogradingState"

// The built-in-autograder selector inside the Submission and grading section.
// Only shown once grading is "Autograded", it offers two radios in this order —
// "built-in" first and the default when a teacher first switches to Autograded:
//   - built-in  : the default-shim path; reveals the declarative tests and the
//                 advanced settings (the caller gates those on
//                 deriveFormShape().showBuiltInConfig).
//   - none      : do NOT use the built-in autograder. Templated -> teacher-
//                 supplied CI (no_autograder on the wire); template-less ->
//                 there's simply no autograder (empty_repo / a plain repo).
//
// Built-in is selectable on ANY repository source, including a no-template
// no-README repo: on that source, picking built-in commits the shim onto an
// initialized repo (the init_shim wire state) rather than leaving it bare. The
// wire mapping (deriveFormShape + toSubmitValues) folds it to init_shim /
// no_autograder accordingly.
//
// Editable after creation: the built-in<->none choice maps to no_autograder /
// init_shim. The domain layer allows changing it; the edit form warns before
// saving when students have already accepted (already-accepted repos aren't
// retrofitted). The radios stay interactive in edit mode with an inline caveat.
const SELECTABLE: readonly AutogradingState[] = ["built-in", "none"]

export function AutogradingStateField({
  form,
  edit,
  hasAcceptedStudents = false,
}: {
  form: AssignmentForm
  edit: boolean
  // Edit mode: whether any student has already accepted. Gates the
  // built-in-autograder change caveat so it shows only when a change would
  // strand existing repos.
  hasAcceptedStudents?: boolean
}) {
  const { t } = useTranslation()

  return (
    <form.Field name="autograding_state">
      {(field) => {
        // A stored bare repo has autograding_state "empty"; show it as "none"
        // (no built-in autograder) since the two radios are none/built-in.
        const selected: AutogradingState =
          field.state.value === "built-in" ? "built-in" : "none"
        // The stored choice mapped the same way, so a change is only real when
        // the none/built-in selection actually flips (a stored "empty" that
        // stays "none" is not a change).
        const defaultSelected: AutogradingState =
          form.options.defaultValues?.autograding_state === "built-in"
            ? "built-in"
            : "none"
        const changed = selected !== defaultSelected
        return (
          <FormField
            htmlFor={field.name}
            label={t("assignments.form.autograding.modeLabel")}
          >
            {({ describedById }) => (
              <div aria-describedby={describedById}>
                <fieldset className="flex flex-col gap-2">
                  <legend className="sr-only">
                    {t("assignments.form.autograding.modeLabel")}
                  </legend>
                  {SELECTABLE.map((option) => (
                    <label
                      key={option}
                      htmlFor={`${field.name}-${option}`}
                      className="flex cursor-pointer items-start justify-start gap-3"
                    >
                      <input
                        id={`${field.name}-${option}`}
                        type="radio"
                        className="radio mt-1"
                        name={field.name}
                        value={option}
                        checked={selected === option}
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
                {edit && hasAcceptedStudents && changed ? (
                  <Alert tone="warning" role="status" className="mt-2 text-sm">
                    <span>{t("assignments.form.autograding.editHelp")}</span>
                  </Alert>
                ) : null}
              </div>
            )}
          </FormField>
        )
      }}
    </form.Field>
  )
}
