import { SearchIcon } from "./icons"
import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { cx, hasUtility } from "./cx"
import { Input, type InputSize } from "./Input"
import { LabeledControl } from "./LabeledControl"
import { SelectAllCheckbox } from "./SelectAllCheckbox"
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
  // A caller gap (e.g., gap-3) overrides the default; without the guard cx would
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
  // The in-search-bar clear affordance: an inline text link at the trailing edge,
  // rendered only when `onClear` is set AND `clearActive` is true. The label is
  // resolved from one source — "Clear filter" when `hasFilterActive`, else
  // "Clear" — so callers pass the boolean, not the wording.
  onClear?: () => void
  clearActive?: boolean
  hasFilterActive?: boolean
  // Escape hatch for a fully custom trailing node inside the shell; `onClear`
  // covers the standard clear affordance and is preferred.
  trailing?: ReactNode
}

function ToolbarSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
  inputSize = "sm",
  className = "min-w-[12rem] flex-1 sm:max-w-xs",
  iconClassName = "opacity-60",
  onClear,
  clearActive = false,
  hasFilterActive = false,
  trailing,
}: ToolbarSearchProps) {
  const { t } = useTranslation()
  const clear =
    onClear && clearActive ? (
      <button
        type="button"
        onClick={onClear}
        className="link link-hover whitespace-nowrap text-xs text-base-content/60 hover:text-base-content"
      >
        {t(hasFilterActive ? "common.clearFilter" : "common.clear")}
      </button>
    ) : null
  return (
    <Input
      type="search"
      inputSize={inputSize}
      className={className}
      leadingIcon={
        <SearchIcon
          aria-hidden="true"
          className={cx("size-4", iconClassName)}
        />
      }
      trailing={trailing ?? clear}
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
  // A compact leading-icon prefix (funnel for a filter, up/down for a sort).
  // Takes precedence over `label`; pass `aria-label` for the category name so the
  // icon prefix stays purely visual. Prefer this over `label` for a tidy bar.
  icon?: ReactNode
  // Warning-toned highlight when the select holds a non-default value (see
  // LabeledControl.active). Leave false for a sort select — a sort is always set,
  // not a narrowing filter.
  active?: boolean
  selectSize?: SelectSize
} & ComponentPropsWithoutRef<"select">

function ToolbarFilterSelect({
  label,
  icon,
  active = false,
  selectSize = "sm",
  className,
  children,
  ...props
}: ToolbarFilterSelectProps) {
  // Match the prefix highlight on the select border/text so the whole control
  // reads as active.
  const activeSelectClass = active ? "border-warning text-warning" : undefined
  // A caller min-width (e.g. min-w-[13rem] for long option labels) overrides
  // the default; without the guard cx would emit both and Tailwind source
  // order is unspecified.
  const hasMinWidth = hasUtility("min-w-", className)
  if (!label && !icon) {
    return (
      <Select
        selectSize={selectSize}
        className={cx(activeSelectClass, className)}
        {...props}
      >
        {children}
      </Select>
    )
  }
  return (
    <LabeledControl label={label} icon={icon} active={active}>
      <Select
        selectSize={selectSize}
        className={cx(
          "join-item w-auto",
          !hasMinWidth && "min-w-0",
          activeSelectClass,
          className,
        )}
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
  // The selection-revealed actions (shown when rows are selected).
  children?: ReactNode
}

function ToolbarSelection({
  allSelected,
  someSelected,
  onToggleSelectAll,
  selectAllAriaLabel,
  label,
  children,
}: ToolbarSelectionProps) {
  return (
    <>
      <label className="flex cursor-pointer items-center gap-3">
        <SelectAllCheckbox
          ariaLabel={selectAllAriaLabel}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggle={onToggleSelectAll}
        />
        <span className="text-sm font-medium tabular-nums">{label}</span>
      </label>
      {children ? (
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      ) : null}
    </>
  )
}

Toolbar.Search = ToolbarSearch
Toolbar.FilterSelect = ToolbarFilterSelect
Toolbar.Trailing = ToolbarTrailing
Toolbar.Selection = ToolbarSelection

export default Toolbar
