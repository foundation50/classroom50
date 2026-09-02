import type { AnchorHTMLAttributes, ReactNode } from "react"

import { LinkExternalIcon } from "./icons"
import { cx } from "./cx"

// A text link that opens off-site in a new tab: the daisyUI `link` recipe, the
// `target`/`rel` pair that a new tab needs, and the trailing external-link
// glyph, so the ~20 hand-written `<a className="link" target="_blank">` sites
// converge on one shape. In-app navigation is the router's `Link`, not this.
export type ExternalLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel" | "children"
> & {
  href: string
  children: ReactNode
  // Drop the glyph where the surrounding text already says it opens elsewhere.
  icon?: boolean
}

export function ExternalLink({
  href,
  children,
  icon = true,
  className,
  ...rest
}: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx("link inline-flex items-center gap-1", className)}
      {...rest}
    >
      {children}
      {icon && <LinkExternalIcon aria-hidden="true" className="size-3.5" />}
    </a>
  )
}
