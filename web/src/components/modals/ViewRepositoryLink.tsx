import { ExternalLink } from "@/components/ui"
import type { ReactNode } from "react"

import { MarkGithubIcon } from "@/components/ui/icons"

/**
 * The "view repository" link modals render at the top of the body — not in the
 * Modal `subtitle` slot, because an interactive link as the dialog's
 * aria-describedby reads poorly for AT users.
 */
export function ViewRepositoryLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
  return (
    <ExternalLink
      className="mt-3 w-fit gap-1.5 text-sm"
      href={href}
      icon={false}
    >
      <MarkGithubIcon aria-hidden="true" className="size-4" />
      {children}
    </ExternalLink>
  )
}
