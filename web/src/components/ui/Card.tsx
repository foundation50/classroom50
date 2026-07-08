import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react"

import { cx } from "./cx"

// The canonical surface card. Wraps daisyUI `card` with one border/shadow/
// radius recipe so the ~6 divergent inline recipes converge. Defaults match the
// most common form/panel card (`bg-base-100 border-base-300 shadow-sm`, box
// radius); `bordered`/`shadow`/`radius` toggle the variants the audit found
// (dashed empties, rounded-xl/2xl list cards). `as` swaps the element tag for
// semantics (e.g. `section`). The `className` escape hatch keeps per-site
// layout utilities (grid spans, `w-full`, `overflow-hidden`).

type CardRadius = "box" | "xl" | "2xl"

const RADIUS_CLASS: Record<CardRadius, string> = {
  box: "",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
}

export type CardProps = {
  as?: ElementType
  bordered?: boolean
  dashed?: boolean
  shadow?: boolean
  radius?: CardRadius
  children?: ReactNode
} & ComponentPropsWithoutRef<"div">

export function Card({
  as: Tag = "div",
  bordered = true,
  dashed = false,
  shadow = true,
  radius = "box",
  className,
  children,
  ...props
}: CardProps) {
  return (
    <Tag
      className={cx(
        "card bg-base-100",
        RADIUS_CLASS[radius],
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
