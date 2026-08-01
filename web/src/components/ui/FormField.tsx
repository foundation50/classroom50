import { HelpCircle } from "lucide-react"
import { useId, type ReactNode } from "react"

import { Button } from "./Button"
import { cx } from "./cx"

// The side a tooltip bubble opens toward. Exported so wrappers (e.g. FieldLabel)
// forward the same set instead of re-declaring it and drifting.
export type HelpTooltipPosition = "top" | "bottom" | "left" | "right"

// A question-mark help affordance: a focusable button carrying detailed
// guidance as its accessible name, wrapped in a theme-aware DaisyUI tooltip.
// The single source for the help-icon markup + a11y contract. `position`
// controls which side the tooltip opens on (default bottom); use `right`/`top`
// inside a narrow container like a modal so the bubble isn't clipped.
export function HelpTooltip({
  help,
  position = "bottom",
}: {
  help: string
  position?: HelpTooltipPosition
}) {
  return (
    <span
      className={cx(
        // before:max-w-[min(20rem,90vw)] keeps a wide bubble from overflowing the
        // viewport near a container edge, which otherwise grows the page's
        // horizontal scroll width and shifts the whole layout left.
        "tooltip align-middle before:max-w-[min(20rem,90vw)] before:whitespace-normal before:text-start",
        {
          top: "tooltip-top",
          bottom: "tooltip-bottom",
          left: "tooltip-left",
          right: "tooltip-right",
        }[position],
      )}
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
  labelExtra,
  error,
  hint,
  className,
  children,
}: {
  label: ReactNode
  // Provide when the control has its own stable id (e.g., TanStack `field.name`);
  // otherwise an id is generated.
  htmlFor?: string
  required?: boolean
  help?: string
  // Rendered in the label row immediately after the help tooltip — e.g. a
  // "Learn more" link to external docs that the tooltip's plain-text bubble
  // can't carry as a clickable element.
  labelExtra?: ReactNode
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
        {labelExtra}
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
