import { ExternalLink } from "@/components/ui"
import { MarkGithubIcon } from "@/components/ui/icons"

// Shared "open on GitHub" deep-link for section headers: the muted ExternalLink
// with the GitHub mark in front. `className` tunes layout per call site (e.g.,
// `shrink-0`).
export const GitHubLink = ({
  href,
  label,
  title,
  className = "",
  showLogo = true,
}: {
  href: string
  label: string
  title?: string
  className?: string
  showLogo?: boolean
}) => (
  <ExternalLink
    href={href}
    title={title}
    variant="muted"
    className={`cursor-pointer gap-1.5 text-sm ${className}`}
  >
    {showLogo && <MarkGithubIcon className="size-4" aria-hidden="true" />}
    {label}
  </ExternalLink>
)

export default GitHubLink
