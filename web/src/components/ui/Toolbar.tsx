import { Search } from "lucide-react"
import type { ComponentPropsWithoutRef, ReactNode } from "react"

import { cx, hasUtility } from "./cx"
import { Input, type InputSize } from "./Input"
import { LabeledControl } from "./LabeledControl"
import { Select, type SelectSize } from "./Select"

// The shared toolbar shell + slots that replace the per-page hand-rolled bars.
// `header` swaps the filter-bar chrome for the bulk-bar table-header chrome so
// both species share one shell.

export type ToolbarProps = {
  header?: boolean
  children?: ReactNode
} & ComponentPropsWithoutRef<"div">

export function Toolbar({
  header = false,
  className,
  children,
  ...props
}: ToolbarProps) {
  // A caller gap (e.g. gap-3) overrides the default; without the guard cx would
  // emit both, and Tailwind source order is unspecified.
  const hasGap = hasUtility("gap-", className)
  return (
    <div
      className={cx(
        "flex flex-wrap items-center",
        header
          ? "gap-x-4 gap-y-3 border-b border-base-300 px-6 py-3"
          : !hasGap && "gap-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type ToolbarSearchProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  inputSize?: InputSize
  // Overrides the default width recipe; relies on Input's own `hasWidth` guard,
  // so a caller `w-full`/`min-w-0` wins over the default.
  className?: string
  iconClassName?: string
}

function ToolbarSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
  inputSize = "sm",
  className = "min-w-[12rem] flex-1 sm:max-w-xs",
  iconClassName = "opacity-60",
}: ToolbarSearchProps) {
  return (
    <Input
      type="search"
      inputSize={inputSize}
      className={className}
      leadingIcon={
        <Search aria-hidden="true" className={cx("size-4", iconClassName)} />
      }
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    />
  )
}

export type ToolbarFilterSelectProps = {
  // Optional: with a label the select gets the joined label-prefix recipe; without
  // one it renders a bare sized Select (the inline bars have no visible prefix).
  label?: string
  selectSize?: SelectSize
} & ComponentPropsWithoutRef<"select">

function ToolbarFilterSelect({
  label,
  selectSize = "sm",
  className,
  children,
  ...props
}: ToolbarFilterSelectProps) {
  if (!label) {
    return (
      <Select selectSize={selectSize} className={className} {...props}>
        {children}
      </Select>
    )
  }
  return (
    <LabeledControl label={label}>
      <Select
        selectSize={selectSize}
        className={cx("join-item w-auto min-w-0", className)}
        {...props}
      >
        {children}
      </Select>
    </LabeledControl>
  )
}

export type ToolbarTrailingProps = {
  children?: ReactNode
} & ComponentPropsWithoutRef<"div">

function ToolbarTrailing({
  className,
  children,
  ...props
}: ToolbarTrailingProps) {
  if (!children) return null
  return (
    <div
      className={cx("ms-auto flex flex-wrap items-center gap-2", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export type ToolbarSelectionProps = {
  allSelected: boolean
  someSelected: boolean
  onToggleSelectAll: () => void
  selectAllAriaLabel: string
  label: ReactNode
  // Rendered between the count and the actions, regardless of selection (e.g. the
  // roster group-by-section toggle).
  aux?: ReactNode
  // The selection-revealed actions (shown when rows are selected).
  children?: ReactNode
  // The no-selection trailing group (e.g. the roster Add/Upload/Invite group).
  idleActions?: ReactNode
}

function ToolbarSelection({
  allSelected,
  someSelected,
  onToggleSelectAll,
  selectAllAriaLabel,
  label,
  aux,
  children,
  idleActions,
}: ToolbarSelectionProps) {
  return (
    <>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          aria-label={selectAllAriaLabel}
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected && !allSelected
          }}
          onChange={onToggleSelectAll}
        />
        <span className="text-sm font-medium tabular-nums">{label}</span>
      </label>
      {aux}
      {children ? (
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      ) : (
        idleActions
      )}
    </>
  )
}

Toolbar.Search = ToolbarSearch
Toolbar.FilterSelect = ToolbarFilterSelect
Toolbar.Trailing = ToolbarTrailing
Toolbar.Selection = ToolbarSelection

export default Toolbar
