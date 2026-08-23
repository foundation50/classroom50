import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react"

import { cx } from "./cx"

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
    <h2 className={cx("card-title", className)} {...props}>
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
