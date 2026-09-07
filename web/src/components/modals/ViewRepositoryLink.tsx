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
    <a
      className="link mt-3 inline-flex w-fit items-center gap-1.5 text-sm"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <MarkGithubIcon aria-hidden="true" className="size-4" />
      {children}
    </a>
  )
}
