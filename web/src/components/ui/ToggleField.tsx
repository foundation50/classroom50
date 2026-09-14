import { cx } from "./cx"
import { fieldLabelClass, HelpTooltip } from "./FormField"
import { Toggle } from "./Toggle"

// A boolean toggle rendered as a DaisyUI switch with a bold label and an
// optional `?` help affordance — the single source for the settings-toggle
// recipe (the label itself states the intent; the tooltip carries the
// "why/how"). Wrapping-label association, so the whole row is clickable.
// Per Primer, an individual checkbox/toggle is never marked required and
// carries no per-control validation message. `onBlur` is optional because a
// picker-revealing toggle (due date) syncs its own state.
export function ToggleField({
  id,
  checked,
  onChange,
  onBlur,
  label,
  help,
  disabled = false,
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  onBlur?: () => void
  label: string
  help?: string
  disabled?: boolean
}) {
  return (
    <label
      htmlFor={id}
      className={cx(
        "flex items-center gap-3",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <Toggle
        id={id}
        checked={checked}
        disabled={disabled}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={fieldLabelClass}>{label}</span>
      {help ? <HelpTooltip help={help} /> : null}
    </label>
  )
}

export default ToggleField
