import type { ComponentPropsWithRef, ElementType, ReactNode } from "react"

import { cx } from "./cx"

// Primer's title scale (primer.style/product/primitives/typography), semibold
// per Primer's title weight: title-medium (20px) for page titles, title-small
// (16px) for section/modal/card titles, subtitle (20px/400) for lead-ins.
// The single source for heading recipes — pages must not hand-roll
// `text-*/font-*` title combos. `as` carries the semantic level (h1-h4),
// which a11yStructural tests audit independently of the visual variant.
export type HeadingVariant = "title-medium" | "title-small" | "subtitle"

export const headingVariantClass: Record<HeadingVariant, string> = {
  "title-medium": "text-xl leading-relaxed font-semibold",
  "title-small": "text-base leading-normal font-semibold",
  subtitle: "text-xl leading-relaxed font-normal",
}

export type HeadingProps = {
  as?: ElementType
  variant?: HeadingVariant
  children?: ReactNode
} & ComponentPropsWithRef<"h2">

export function Heading({
  as: Tag = "h2",
  variant = "title-small",
  className,
  children,
  ...props
}: HeadingProps) {
  return (
    <Tag className={cx(headingVariantClass[variant], className)} {...props}>
      {children}
    </Tag>
  )
}

export default Heading
