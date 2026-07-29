import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"

// A section heading that doubles as its own anchor: the heading text itself is a
// link that sets the URL hash to `anchorId`, which useHashSectionHighlight picks
// up to scroll + highlight the section — and the hash stays in the URL so the
// position is shareable/bookmarkable. A hover underline is the only affordance,
// so the row stays as tight as a plain heading (no extra icon pushing an
// adjacent tooltip away).
//
// `to="."` keeps the current path (and search); only the hash changes.
export function SectionAnchorHeading({
  anchorId,
  children,
  className,
  as: Tag = "h2",
}: {
  anchorId: string
  children: ReactNode
  className?: string
  as?: "h2" | "h3"
}) {
  const { t } = useTranslation()
  const label =
    typeof children === "string"
      ? t("common.linkToSection", { section: children })
      : t("common.linkToSectionGeneric")

  return (
    <Tag className={className}>
      <Link
        to="."
        hash={anchorId}
        aria-label={label}
        className="no-underline hover:underline"
      >
        {children}
      </Link>
    </Tag>
  )
}

export default SectionAnchorHeading
