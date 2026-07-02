import type { ComponentPropsWithoutRef } from "react"
import { useTranslation } from "react-i18next"

type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl"

/**
 * Accessible loading spinner. Wraps the daisyUI `loading loading-spinner` in a
 * `role="status"` region with a visually-hidden label so screen readers
 * announce the busy state instead of hitting a silent, decorative `<span>`.
 *
 * Pass `label` to customize what's announced (e.g. "Loading submissions").
 *
 * When to use which:
 * - Use `<Spinner>` for a spinner that is the ONLY indicator of a loading
 *   region/page (otherwise silent to screen readers).
 * - Keep a bare `loading loading-spinner` span (with `aria-hidden`) when the
 *   busy state is already announced by adjacent visible text or by the enclosing
 *   control's accessible name (e.g. an in-button spinner while a labeled button
 *   is disabled, or a spinner beside a "Loading…" paragraph). The
 *   `no-restricted-syntax` lint rule flags bare spinners as a nudge; `aria-hidden`
 *   is the correct resolution for those already-announced cases.
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
