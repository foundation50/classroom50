import { useTranslation } from "react-i18next"
import { FormField } from "@/components/ui"
import type { AssignmentForm } from "../assignmentFormModel"
import type { AutogradingState } from "@/domain/assignments/autogradingState"

// The built-in-autograder selector inside the Autograding section. Only shown
// once grading is "Autograded" (the section swaps to a note otherwise), it
// offers two radios in this order — "none" first and DEFAULT:
//   - none      : do NOT use the built-in autograder. Templated -> teacher-
//                 supplied CI (no_autograder on the wire); template-less ->
//                 there's simply no autograder (empty_repo / a plain repo).
//   - built-in  : the default-shim path; reveals the advanced settings and
//                 declarative tests (the caller gates those on
//                 deriveFormShape().showBuiltInConfig).
//
// Built-in is selectable on ANY repository source, including a no-template
// no-README repo: on that source, picking built-in commits the shim onto an
// initialized repo (the init_shim wire state) rather than leaving it bare. The
// wire mapping (deriveFormShape + toSubmitValues) folds it to init_shim /
// no_autograder accordingly.
//
// Immutable after creation: the none<->built-in choice maps to no_autograder /
// init_shim, which the domain layer rejects changing on edit (already-accepted
// repos aren't retrofitted). So on edit the radios render locked, mirroring the
// repository-source field.
const SELECTABLE: readonly AutogradingState[] = ["none", "built-in"]

export function AutogradingStateField({
  form,
  edit,
}: {
  form: AssignmentForm
  edit: boolean
}) {
  const { t } = useTranslation()

  return (
    <form.Field name="autograding_state">
      {(field) => {
        const locked = edit
        // A stored bare repo has autograding_state "empty"; show it as "none"
        // (no built-in autograder) since the two radios are none/built-in.
        const selected: AutogradingState =
          field.state.value === "built-in" ? "built-in" : "none"
        return (
          <FormField
            htmlFor={field.name}
            label={t("assignments.form.autograding.modeLabel")}
          >
            {({ describedById }) => (
              <div aria-describedby={describedById}>
                <fieldset
                  className={
                    locked
                      ? "flex flex-col gap-2 pointer-events-none opacity-50"
                      : "flex flex-col gap-2"
                  }
                  disabled={locked}
                  aria-disabled={locked}
                >
                  <legend className="sr-only">
                    {t("assignments.form.autograding.modeLabel")}
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
                        checked={selected === option}
                        disabled={locked}
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
                {locked ? (
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.autograding.lockedHelp")}
                  </p>
                ) : null}
              </div>
            )}
          </FormField>
        )
      }}
    </form.Field>
  )
}
