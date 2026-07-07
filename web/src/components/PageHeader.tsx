import type { ReactNode } from "react"

// The dashboard page heading: a title, an optional subtitle line, and an
// optional right-aligned action. `loading` swaps the title for the standard
// skeleton placeholder (pages that resolve the title async render it there
// instead of hand-rolling the swap). title/subtitle/action are ReactNode so a
// page can render an inline badge in the heading or a composite subtitle
// (org-link line, follow-up link) through the slots.
export default function PageHeader({
  title,
  subtitle,
  action,
  loading = false,
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  loading?: boolean
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {loading ? (
          <div className="skeleton skeleton-shimmer h-8 w-48" />
        ) : (
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        )}
        {subtitle && (
          <div className="mt-1 text-sm text-base-content/70">{subtitle}</div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// The org deep-link fragment shared by the owner-page subtitles: a monospace
// link to the org on github.com, falling back to plain text when the slug isn't
// resolved yet. The surrounding prefix/suffix text and any follow-up link stay
// in the page's subtitle/action slots — they differ per page.
export function OrgLink({
  org,
  href,
  title,
}: {
  org: string | undefined
  href: string
  title: string
}) {
  if (!org) return <span className="font-mono font-semibold">{org}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="font-mono font-semibold hover:text-primary hover:underline"
    >
      {org}
    </a>
  )
}
