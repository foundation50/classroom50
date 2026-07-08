import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react"

import { cx } from "./cx"

// The canonical text input. Wraps daisyUI `input input-bordered w-full` so the
// two competing conventions (`input w-full` vs `input input-bordered`) converge
// on the bordered one. `invalid` adds `input-error` (wire it to the field's
// error state); `size` maps the daisyUI size modifiers. `ref` is a plain prop
// (React 19). The `className` escape hatch keeps per-site layout utilities
// (`font-mono`, `join-item`, width overrides).
//
// `leadingIcon` renders an icon inside the bordered shell (daisyUI's
// `<label class="input">` wrapper pattern) with a single border owner — use it
// for search fields instead of hand-rolling a `<label class="input">` around a
// bare `<input>` (which would double-border if combined with this primitive).

export type InputSize = "xs" | "sm" | "md"

const SIZE_CLASS: Record<InputSize, string> = {
  xs: "input-xs",
  sm: "input-sm",
  md: "",
}

export type InputProps = {
  inputSize?: InputSize
  invalid?: boolean
  leadingIcon?: ReactNode
  ref?: Ref<HTMLInputElement>
} & ComponentPropsWithoutRef<"input">

export function Input({
  inputSize = "md",
  invalid = false,
  leadingIcon,
  className,
  type,
  ref,
  ...props
}: InputProps) {
  // Only default to full width when the caller hasn't set their own width; a
  // trailing `w-full` in the recipe would otherwise beat a per-site `w-32` (cx
  // doesn't merge Tailwind classes, and same-property source order is
  // unspecified).
  const hasWidth = className ? /(?:^|\s)w-/.test(className) : false

  // With a leading icon, the border lives on the wrapping <label> (daisyUI's
  // documented pattern) and the <input> is a bare grower — a single border
  // owner, no focus-ring conflict.
  if (leadingIcon) {
    return (
      <label
        className={cx(
          "input input-bordered",
          !hasWidth && "w-full",
          SIZE_CLASS[inputSize],
          invalid && "input-error",
          "flex items-center gap-2",
          className,
        )}
      >
        {leadingIcon}
        <input
          ref={ref}
          type={type ?? "text"}
          className="grow"
          aria-invalid={invalid || undefined}
          {...props}
        />
      </label>
    )
  }

  return (
    <input
      ref={ref}
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
