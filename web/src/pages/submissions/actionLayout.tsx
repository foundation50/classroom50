import { ChevronRightIcon, LinkExternalIcon } from "@primer/octicons-react"

import { Button } from "@/components/ui"
import { rtlFlip } from "@/components/ui"

type IconComponent = React.ComponentType<{ className?: string }>

// A labeled action row for the submission hub: leading icon, title + optional
// description, trailing affordance (an external-link glyph for links, else a
// chevron). Renders as an <a> when `href` is set, otherwise a <button> driving
// `onClick`. Disabled state dims and inerts it.
export const ActionListRow = ({
  icon: Icon,
  title,
  description,
  href,
  onClick,
  disabled = false,
  loading = false,
  loadingLabel,
  ariaLabel,
  external = false,
}: {
  icon: IconComponent
  title: string
  description?: string
  href?: string | null
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  loadingLabel?: string
  ariaLabel?: string
  // Link actions leave the app (open a repo/commit/PR in a new tab); mark them
  // so the row shows an external-link glyph instead of the navigational chevron.
  external?: boolean
}) => {
  const trailing = external ? (
    <LinkExternalIcon
      aria-hidden="true"
      className="size-4 shrink-0 opacity-60"
    />
  ) : (
    <ChevronRightIcon
      aria-hidden="true"
      className={`size-4 shrink-0 opacity-40 ${rtlFlip}`}
    />
  )

  const body = (
    <>
      {!loading && <Icon className="size-5 shrink-0 text-base-content/70" />}
      <span className="flex min-w-0 flex-col items-start text-start">
        <span className="font-medium">{title}</span>
        {description ? (
          <span className="text-xs font-normal text-base-content/60">
            {description}
          </span>
        ) : null}
      </span>
      <span className="ms-auto">{trailing}</span>
    </>
  )

  const shared = {
    variant: "ghost" as const,
    className: "w-full justify-start gap-3 h-auto py-2.5 normal-case",
    disabled,
    loading,
    loadingLabel,
    "aria-label": ariaLabel,
  }

  return href !== undefined ? (
    <Button
      as="a"
      href={href ?? undefined}
      target="_blank"
      rel="noreferrer"
      {...shared}
    >
      {body}
    </Button>
  ) : (
    <Button onClick={onClick} {...shared}>
      {body}
    </Button>
  )
}
