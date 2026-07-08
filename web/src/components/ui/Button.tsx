import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react"

import { Spinner } from "@/components/Spinner"

import { cx } from "./cx"

// The canonical button. Wraps daisyUI `btn` so the ~160 inline sites share one
// prop->class mapping instead of hand-ordered modifier strings. Color/size are
// props; icon-only buttons pick a `shape`; `loading` renders the accessible
// Spinner inside and disables the button (replacing the hand-placed inner
// spinners the audit found). A trailing `className` escape hatch stays for the
// per-site layout utilities (`w-full`, `join-item`, `self-start`, ...). `ref`
// is a plain prop (React 19) so sites that manage focus can still reach the
// underlying <button>.

export type ButtonVariant =
  | "primary"
  | "ghost"
  | "outline"
  | "error"
  | "warning"
  | "success"
  | "info"
  | "neutral"

export type ButtonSize = "xs" | "sm" | "md"

export type ButtonShape = "default" | "square" | "circle"

// `neutral` is the bare `btn` (no color modifier); `outline` maps to the
// primary outline, the only outline color used across the app.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  ghost: "btn-ghost",
  outline: "btn-outline btn-primary",
  error: "btn-error",
  warning: "btn-warning",
  success: "btn-success",
  info: "btn-info",
  neutral: "",
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "btn-xs",
  sm: "btn-sm",
  md: "",
}

const SHAPE_CLASS: Record<ButtonShape, string> = {
  default: "",
  square: "btn-square",
  circle: "btn-circle",
}

const SPINNER_SIZE: Record<ButtonSize, "xs" | "sm" | "md"> = {
  xs: "xs",
  sm: "sm",
  md: "sm",
}

export type ButtonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  active?: boolean
  loading?: boolean
  loadingLabel?: string
  ref?: Ref<HTMLButtonElement>
  children?: ReactNode
} & Omit<ComponentPropsWithoutRef<"button">, "children">

export function Button({
  variant = "neutral",
  size = "md",
  shape = "default",
  active = false,
  loading = false,
  loadingLabel,
  className,
  disabled,
  type,
  ref,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cx(
        "btn",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        SHAPE_CLASS[shape],
        active && "btn-active",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner size={SPINNER_SIZE[size]} label={loadingLabel} />}
      {children}
    </button>
  )
}

export default Button
