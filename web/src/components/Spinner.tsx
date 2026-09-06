import type { ComponentPropsWithoutRef } from "react"
import { useTranslation } from "react-i18next"

import { useAnnounce } from "@/hooks/useAnnounce"

type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl"

/**
 * Loading spinner whose `label` is announced through the app's persistent live
 * region (`useAnnounce`), so several spinners on one page announce once. Use it
 * when the spinner is the only loading indicator; when the busy state is
 * already announced (adjacent text, a labeled disabled button), use
 * `InlineSpinner`, which is what the `no-restricted-syntax` lint nudge expects.
 *
 * The visual is anti-flash guarded (`indicator-appear`): invisible for the
 * first ~250ms so sub-second loads never flash (Primer loading guidance). The
 * announcement is not delayed.
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
  useAnnounce(label ?? t("common.loading"))
  return (
    <span
      className={`inline-flex items-center justify-center${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      {...props}
    >
      <span
        className={`loading loading-spinner loading-${size} indicator-appear`}
      />
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
