import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"

// Monotonic per-session counter so every click stamps a distinct scrollNonce —
// unlike Date.now(), which can repeat within a millisecond and let the hook's
// dedupe guard swallow a legitimate re-click.
let scrollSeq = 0

// A section heading whose text is a link that sets the URL hash to `anchorId`
// (shareable/bookmarkable). useHashSectionHighlight owns the resulting scroll +
// highlight, so there is exactly one scroll per click.
//
// preventDefault blocks the browser's instant fragment jump; a `scrollNonce` in
// history state makes an identical-hash re-click still register as a change the
// hook reacts to (TanStack otherwise no-ops a same-hash navigation).
// `replace: true` keeps repeated in-page section clicks off the back-button
// history.
export function SectionAnchorHeading({
  anchorId,
  children,
  className,
  as: Tag = "h2",
}: {
  anchorId: string
  children: string
  className?: string
  as?: "h2" | "h3"
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Tag className={className}>
      <a
        href={`#${anchorId}`}
        aria-label={t("common.linkToSection", { section: children })}
        className="no-underline hover:underline"
        onClick={(e) => {
          e.preventDefault()
          void navigate({
            to: ".",
            hash: anchorId,
            replace: true,
            state: (prev) => ({ ...prev, scrollNonce: ++scrollSeq }),
          })
        }}
      >
        {children}
      </a>
    </Tag>
  )
}

export default SectionAnchorHeading
