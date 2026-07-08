import type { ComponentPropsWithoutRef, Ref } from "react"

import { cx } from "./cx"

// The canonical multi-line input. Wraps daisyUI `textarea textarea-bordered
// w-full` (the audit found multi-line entry was styled ad hoc). `invalid` adds
// `textarea-error`.
export type TextareaProps = {
  invalid?: boolean
  ref?: Ref<HTMLTextAreaElement>
} & ComponentPropsWithoutRef<"textarea">

export function Textarea({
  invalid = false,
  className,
  ...props
}: TextareaProps) {
  return (
    <textarea
      className={cx(
        "textarea textarea-bordered w-full",
        invalid && "textarea-error",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  )
}

export default Textarea
