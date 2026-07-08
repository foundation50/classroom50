import type { ComponentPropsWithoutRef, Ref } from "react"

import { cx } from "./cx"

// The canonical text input. Wraps daisyUI `input input-bordered w-full` so the
// two competing conventions (`input w-full` vs `input input-bordered`) converge
// on the bordered one. `invalid` adds `input-error` (wire it to the field's
// error state); `size` maps the daisyUI size modifiers. `ref` is a plain prop
// (React 19). The `className` escape hatch keeps per-site layout utilities
// (`font-mono`, `join-item`, width overrides).

export type InputSize = "xs" | "sm" | "md"

const SIZE_CLASS: Record<InputSize, string> = {
  xs: "input-xs",
  sm: "input-sm",
  md: "",
}

export type InputProps = {
  inputSize?: InputSize
  invalid?: boolean
  ref?: Ref<HTMLInputElement>
} & ComponentPropsWithoutRef<"input">

export function Input({
  inputSize = "md",
  invalid = false,
  className,
  type,
  ...props
}: InputProps) {
  // Only default to full width when the caller hasn't set their own width; a
  // trailing `w-full` in the recipe would otherwise beat a per-site `w-32` (cx
  // doesn't merge Tailwind classes, and same-property source order is
  // unspecified).
  const hasWidth = className ? /(?:^|\s)w-/.test(className) : false
  return (
    <input
      type={type ?? "text"}
      className={cx(
        "input input-bordered",
        !hasWidth && "w-full",
        SIZE_CLASS[inputSize],
        invalid && "input-error",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  )
}

export default Input
