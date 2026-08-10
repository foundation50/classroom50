import { useTranslation } from "react-i18next"
import { FormField } from "@/components/ui"
import type { AssignmentForm } from "../assignmentFormModel"
import type { AutogradingState } from "@/domain/assignments/autogradingState"

// The autograding selector (assignment-form IA overhaul U3/U7 + empty-repo
// gating). Two radios in this order:
//   - none      : no built-in autograder. Templated -> teacher-supplied CI
//                 (no_autograder on the wire). Uninitialized (empty) repo ->
//                 there's simply no autograder (empty_repo on the wire). This
//                 is the FIRST option and the default.
//   - built-in  : the default-shim path; reveals triggers / advanced / tests
//                 (gated by the caller on autograding_state === "built-in").
//
// Built-in requires an INITIALIZED repo (a README, or a non-empty template) —
// a bare repo has no commit to attach a workflow to. While the repo is
// uninitialized, "No built-in autograder" is force-selected and "Built-in
// autograder" is disabled with a hint pointing back to Repository Setup.
// (Initializing an otherwise-empty repo with a shim-only commit is a separate
// cross-tool change; until it lands, built-in stays gated behind init.)
//
// Immutable after creation: the none<->built-in choice maps to no_autograder,
// which the domain layer rejects changing on edit, so the radios lock on edit
// (mirroring the repository-source field).
const SELECTABLE: readonly AutogradingState[] = ["none", "built-in"]

export function AutogradingStateField({
  form,
  edit,
  emptyRepo,
}: {
  form: AssignmentForm
  edit: boolean
  // The repo is uninitialized (no README, no template): built-in autograding
  // can't attach, so it's disabled and "none" is force-selected.
  emptyRepo: boolean
}) {
  const { t } = useTranslation()

  return (
    <form.Field name="autograding_state">
      {(field) => {
        // Built-in is unavailable on an uninitialized repo; the effective
        // selection is then "none" regardless of the stored value. On an
        // initialized repo it's the teacher's pick.
        const effective: AutogradingState = emptyRepo
          ? "none"
          : field.state.value
        const locked = edit
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
                  {SELECTABLE.map((option) => {
                    // Built-in needs an initialized repo; disable it while empty.
                    const optionDisabled =
                      locked || (option === "built-in" && emptyRepo)
                    return (
                      <label
                        key={option}
                        htmlFor={`${field.name}-${option}`}
                        className={
                          optionDisabled && !locked
                            ? "label items-start justify-start gap-3 p-0 opacity-50"
                            : "label cursor-pointer items-start justify-start gap-3 p-0"
                        }
                      >
                        <input
                          id={`${field.name}-${option}`}
                          type="radio"
                          className="radio mt-1"
                          name={field.name}
                          value={option}
                          checked={effective === option}
                          disabled={optionDisabled}
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
                    )
                  })}
                </fieldset>
                {emptyRepo && !locked ? (
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.autograding.builtInNeedsInit")}
                  </p>
                ) : null}
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
