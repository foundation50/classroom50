import { HelpCircle } from "lucide-react"
import { useId, type ReactNode } from "react"

import { Button } from "./Button"
import { cx } from "./cx"

// A question-mark help affordance: a focusable button carrying detailed
// guidance as its accessible name, wrapped in a theme-aware DaisyUI tooltip.
// The single source for the help-icon markup + a11y contract.
export function HelpTooltip({ help }: { help: string }) {
  return (
    <span
      className="tooltip tooltip-bottom before:max-w-xs before:whitespace-normal before:text-start"
      data-tip={help}
    >
      <Button
        variant="ghost"
        size="xs"
        shape="circle"
        aria-label={help}
        className="text-base-content/50 hover:text-base-content"
      >
        <HelpCircle aria-hidden="true" className="size-4" />
      </Button>
    </span>
  )
}

type FieldRenderArgs = {
  // Wire these onto the control so the label, error, and control stay linked.
  id: string
  describedById: string | undefined
  invalid: boolean
}

// The canonical form field: a bold label (optional required marker + help
// tooltip), the control, an optional error message (role="alert"), and optional
// helper text. Unifies the 4 label patterns and 3 error-display markups the
// audit found. `children` is a render prop that receives the generated `id`,
// the `aria-describedby` target (error/help), and `invalid` so the control can
// wire its a11y attributes; pass the field's error into `error` (a truthy value
// switches the field into the invalid state).
export function FormField({
  label,
  htmlFor,
  required = false,
  help,
  error,
  hint,
  className,
  children,
}: {
  label: ReactNode
  // Provide when the control has its own stable id (e.g. TanStack `field.name`);
  // otherwise an id is generated.
  htmlFor?: string
  required?: boolean
  help?: string
  error?: ReactNode
  hint?: ReactNode
  className?: string
  children: (args: FieldRenderArgs) => ReactNode
}) {
  const generatedId = useId()
  const id = htmlFor ?? generatedId
  const invalid = Boolean(error)
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedById = invalid ? errorId : hint ? hintId : undefined

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="label font-bold">
          {label}
          {required ? (
            <span className="text-error" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
        {help ? <HelpTooltip help={help} /> : null}
      </div>

      {children({ id, describedById, invalid })}

      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-base-content/70">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export default FormField
