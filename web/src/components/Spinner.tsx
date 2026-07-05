import type { ComponentPropsWithoutRef } from "react"
import { useTranslation } from "react-i18next"

type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl"

/**
 * Accessible loading spinner: daisyUI `loading-spinner` in a `role="status"`
 * region with a visually-hidden `label` so screen readers announce the busy
 * state. Use when the spinner is the ONLY loading indicator; when the busy
 * state is already announced (adjacent text, an in-button spinner on a labeled
 * disabled button), keep a bare `aria-hidden` span — the resolution the
 * `no-restricted-syntax` lint nudge expects.
 */
export function Spinner({
  size = "md",
  label,
  className,
  ...props
}: {
  size?: SpinnerSize
  label?: string
} & Omit<ComponentPropsWithoutRef<"span">, "children">) {
  const { t } = useTranslation()
  const resolvedLabel = label ?? t("common.loading")
  return (
    <span
      role="status"
      className={`inline-flex items-center justify-center${className ? ` ${className}` : ""}`}
      {...props}
    >
      <span
        className={`loading loading-spinner loading-${size}`}
        aria-hidden="true"
      />
      <span className="sr-only">{resolvedLabel}</span>
    </span>
  )
}

export default Spinner
