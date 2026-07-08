import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
  Ref,
} from "react"

import { Spinner } from "@/components/Spinner"

import { cx } from "./cx"

// The canonical button. Wraps daisyUI `btn` so the ~160 inline sites share one
// prop->class mapping instead of hand-ordered modifier strings. Color/size are
// props; icon-only buttons pick a `shape`; `loading` renders the accessible
// Spinner inside and disables the button (replacing the hand-placed inner
// spinners the audit found). A trailing `className` escape hatch stays for the
// per-site layout utilities (`w-full`, `join-item`, `self-start`, ...). `ref`
// is a plain prop (React 19) so sites that manage focus can still reach the
// underlying element.
//
// Passing `href` (or `as="a"`) renders an <a> that reuses the same recipe, so
// link-shaped actions (open a repo/commit in a new tab) share the button look
// without a hand-written `<a class="btn">`. daisyUI's `btn` styles anchors
// identically. `target`/`rel` pass straight through the native anchor props.

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

type CommonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  active?: boolean
  loading?: boolean
  loadingLabel?: string
  children?: ReactNode
}

// A single props shape (not a discriminated union) so `onClick` and the other
// button handlers keep inferring their event types at every call site — a union
// of button/anchor props collapses those handler params to `any`. The anchor
// variant is opt-in via `as="a"` or `href`; anchor-only attributes (`href`,
// `target`, `rel`, `download`) are folded in as optional. `disabled` is
// accepted on both; on an anchor it renders as inert (no href + aria-disabled).
export type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    as?: "button" | "a"
    href?: string
    target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"]
    rel?: string
    download?: AnchorHTMLAttributes<HTMLAnchorElement>["download"]
    ref?: Ref<HTMLButtonElement | HTMLAnchorElement>
  }

export function Button({
  variant = "neutral",
  size = "md",
  shape = "default",
  active = false,
  loading = false,
  loadingLabel,
  className,
  children,
  as,
  href,
  target,
  rel,
  download,
  disabled,
  type,
  ref,
  ...rest
}: ButtonProps) {
  const classes = cx(
    "btn",
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    SHAPE_CLASS[shape],
    active && "btn-active",
    className,
  )

  const inner = (
    <>
      {loading && <Spinner size={SPINNER_SIZE[size]} label={loadingLabel} />}
      {children}
    </>
  )

  // Render an <a> when the caller asked for one (via `as="a"` or an `href`).
  // Anchors can't be natively `disabled`, so a loading/disabled anchor drops
  // its href and marks aria-disabled to keep it inert and announced.
  if (as === "a" || (as === undefined && href !== undefined)) {
    const inert = disabled || loading
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        className={classes}
        href={inert ? undefined : href}
        target={target}
        rel={rel}
        download={download}
        aria-disabled={inert || undefined}
        aria-busy={loading || undefined}
        {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {inner}
      </a>
    )
  }

  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {inner}
    </button>
  )
}

export default Button
