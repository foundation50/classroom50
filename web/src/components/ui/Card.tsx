import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react"

import { cx } from "./cx"
import { headingVariantClass } from "./Heading"

// The canonical surface card. Wraps daisyUI `card` with one border/shadow/
// radius recipe so the ~6 divergent inline recipes converge. Muted gray on the
// white canvas per GitHub Product UI (`bg-base-200 border-base-300`, box
// radius); `bordered`/`shadow` toggle the variants the audit found (dashed
// empties). `as` swaps the element tag for
// semantics (e.g., `section`). The `className` escape hatch keeps per-site
// layout utilities (grid spans, `w-full`, `overflow-hidden`).

export type CardProps = {
  as?: ElementType
  bordered?: boolean
  dashed?: boolean
  shadow?: boolean
  children?: ReactNode
  // Form-only, meaningful with `as="form"`: the prop type is div-based, so
  // the one form attribute our forms need is folded in rather than making
  // Card fully polymorphic for a single consumer pair.
  noValidate?: boolean
} & ComponentPropsWithoutRef<"div">

export function Card({
  as: Tag = "div",
  bordered = true,
  dashed = false,
  shadow = true,
  className,
  children,
  ...props
}: CardProps) {
  return (
    <Tag
      className={cx(
        "card bg-base-200",
        bordered &&
          (dashed
            ? "border border-dashed border-base-300"
            : "border border-base-300"),
        shadow && "shadow-sm",
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  )
}

export function CardBody({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cx("card-body", className)} {...props}>
      {children}
    </div>
  )
}

export function CardTitle({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"h2">) {
  return (
    // daisyUI `card-title` (18px/600) replaced by the Primer title-small
    // recipe; keeps card-title's inline-flex layout for leading icons.
    <h2
      className={cx(
        "flex items-center gap-2",
        headingVariantClass["title-small"],
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  )
}

export function CardActions({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cx("card-actions", className)} {...props}>
      {children}
    </div>
  )
}

Card.Body = CardBody
Card.Title = CardTitle
Card.Actions = CardActions

export default Card
