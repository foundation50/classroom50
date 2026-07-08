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

type ButtonElementProps = CommonProps & {
  as?: "button"
  ref?: Ref<HTMLButtonElement>
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">

type AnchorElementProps = CommonProps & {
  as: "a"
  ref?: Ref<HTMLAnchorElement>
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children">

// A caller that passes `href` gets the anchor variant without spelling `as="a"`.
type AnchorShorthandProps = CommonProps & {
  as?: undefined
  href: string
  ref?: Ref<HTMLAnchorElement>
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children">

export type ButtonProps =
  | ButtonElementProps
  | AnchorElementProps
  | AnchorShorthandProps

export function Button(props: ButtonProps) {
  const {
    variant = "neutral",
    size = "md",
    shape = "default",
    active = false,
    loading = false,
    loadingLabel,
    className,
    children,
    ...rest
  } = props

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
  if (props.as === "a" || (props.as === undefined && "href" in props)) {
    const {
      as: _as,
      ref,
      href,
      disabled,
      ...anchorRest
    } = rest as AnchorHTMLAttributes<HTMLAnchorElement> & {
      as?: "a"
      ref?: Ref<HTMLAnchorElement>
      href?: string
      disabled?: boolean
    }
    const inert = disabled || loading
    return (
      <a
        ref={ref}
        className={classes}
        href={inert ? undefined : href}
        aria-disabled={inert || undefined}
        aria-busy={loading || undefined}
        {...anchorRest}
      >
        {inner}
      </a>
    )
  }

  const {
    ref,
    type,
    disabled,
    ...buttonRest
  } = rest as ButtonHTMLAttributes<HTMLButtonElement> & {
    ref?: Ref<HTMLButtonElement>
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...buttonRest}
    >
      {inner}
    </button>
  )
}

export default Button
