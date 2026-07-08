import type { ComponentPropsWithoutRef, Ref } from "react"

import { cx } from "./cx"

// The canonical select. Wraps daisyUI `select select-bordered w-full` to match
// the Input convention. `invalid` adds `select-error`; `selectSize` maps size
// modifiers. `className` keeps per-site layout (`w-auto`, `min-w-0`, `flex-1`).

export type SelectSize = "xs" | "sm" | "md"

const SIZE_CLASS: Record<SelectSize, string> = {
  xs: "select-xs",
  sm: "select-sm",
  md: "",
}

export type SelectProps = {
  selectSize?: SelectSize
  invalid?: boolean
  ref?: Ref<HTMLSelectElement>
} & ComponentPropsWithoutRef<"select">

export function Select({
  selectSize = "md",
  invalid = false,
  className,
  children,
  ...props
}: SelectProps) {
  const hasWidth = className ? /(?:^|\s)w-/.test(className) : false
  return (
    <select
      className={cx(
        "select select-bordered",
        !hasWidth && "w-full",
        SIZE_CLASS[selectSize],
        invalid && "select-error",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    >
      {children}
    </select>
  )
}

export default Select
