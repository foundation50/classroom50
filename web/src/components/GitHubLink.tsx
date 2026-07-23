import { ExternalLink } from "lucide-react"
import GitHub from "@/assets/github.svg?react"

// Shared "open on GitHub" deep-link, so the section headers that use it can't
// drift in markup. `className` tunes layout per call site (e.g., `shrink-0`).
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
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    title={title}
    className={`inline-flex cursor-pointer items-center gap-1.5 text-sm text-base-content/70 hover:text-primary ${className}`}
  >
    {showLogo && <GitHub className="size-4" aria-hidden="true" />}
    {label}
    <ExternalLink className="size-3" aria-hidden="true" />
  </a>
)

export default GitHubLink
