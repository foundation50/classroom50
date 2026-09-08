import type { AnchorHTMLAttributes, ReactNode } from "react"

import { LinkExternalIcon } from "./icons"
import { cx, hasUtility } from "./cx"

// The three text-link recipes an off-site anchor takes in this app. Anything
// else (a card, an avatar, a badge, a menu item) is not a text link and stays a
// bare <a>.
export type ExternalLinkVariant =
  // The daisyUI `link` (underlined) text link.
  | "link"
  // The quiet "open on GitHub" affordance beside a settings section: muted
  // until hovered, no underline.
  | "muted"
  // Only the layout, target/rel and glyph; the caller styles the text.
  | "plain"

const variantClass: Record<ExternalLinkVariant, string> = {
  link: "link items-center",
  muted: "items-center text-base-content/70 hover:text-primary",
  plain: "items-center",
}

// A text link that opens off-site in a new tab: the `target`/`rel` pair a new
// tab needs, the inline-flex row, and the trailing external-link glyph, so the
// hand-written `<a target="_blank" rel="noreferrer">` sites converge on one
// shape. In-app navigation is the router's `Link`, not this.
export type ExternalLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel" | "children"
> & {
  href: string
  children: ReactNode
  variant?: ExternalLinkVariant
  // Drop the glyph where the surrounding text already says it opens elsewhere,
  // or where a leading icon (the GitHub mark) carries that meaning.
  icon?: boolean
}

const setsDisplay = (className: string | undefined) =>
  Boolean(className && /(^|\s)(inline-)?flex(\s|$)/.test(className))

export function ExternalLink({
  href,
  children,
  variant = "link",
  icon = true,
  className,
  ...rest
}: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx(
        variantClass[variant],
        // A caller that sets `flex` gets a block-level link on its own line
        // (a note's follow-up link); otherwise the link flows inline.
        !setsDisplay(className) && "inline-flex",
        !hasUtility("gap-", className) && "gap-1",
        className,
      )}
      {...rest}
    >
      {children}
      {icon && <LinkExternalIcon aria-hidden="true" className="size-3.5" />}
    </a>
  )
}
