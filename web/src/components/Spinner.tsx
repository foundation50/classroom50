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
 *
 * The visual is anti-flash guarded (`indicator-appear`): it stays invisible
 * for the first ~250ms so sub-second loads never flash an indicator (Primer
 * loading guidance). The sr-only label is not delayed.
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
        className={`loading loading-spinner loading-${size} indicator-appear`}
        aria-hidden="true"
      />
      <span className="sr-only">{resolvedLabel}</span>
    </span>
  )
}

export default Spinner

/**
 * Decorative in-button/inline spinner: a bare `aria-hidden` span for busy
 * states that are already announced elsewhere (a labeled disabled button,
 * adjacent text). Use `<Spinner>` when the spinner is the only indicator.
 * Anti-flash guarded like `<Spinner>`; pass `immediate` when the parent
 * already delays its own reveal.
 */
export function InlineSpinner({
  size = "xs",
  className,
  immediate = false,
}: {
  size?: SpinnerSize
  className?: string
  immediate?: boolean
}) {
  return (
    <span
      className={`loading loading-spinner loading-${size}${immediate ? "" : " indicator-appear"}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    />
  )
}
