import { Checkbox } from "./Checkbox"

// The tri-state select-all checkbox (checked / indeterminate / empty), shared
// by Toolbar.Selection and table headers that host select-all in the select
// column. One recipe so the checkbox chrome and the indeterminate wiring
// can't drift.
export function SelectAllCheckbox({
  allSelected,
  someSelected,
  onToggle,
  ariaLabel,
  disabled = false,
  className,
}: {
  allSelected: boolean
  someSelected: boolean
  onToggle: () => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}) {
  return (
    <Checkbox
      className={className}
      aria-label={ariaLabel}
      disabled={disabled}
      checked={allSelected}
      ref={(el) => {
        if (el) el.indeterminate = someSelected && !allSelected
      }}
      onChange={onToggle}
    />
  )
}

export default SelectAllCheckbox
