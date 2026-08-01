import type { ComponentType, ReactNode, SVGProps } from "react"

export type InlineNoteTone = "success" | "warning" | "error" | "neutral"

// DaisyUI semantic tints (theme-aware), replacing the former raw Tailwind
// palette (`green-50`/`amber-50`/...) so inline notes track the active theme
// like the rest of the app. Each tone is a soft tint of its semantic token with
// a matching border and readable foreground.
const TONE_CLASS: Record<InlineNoteTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-error/30 bg-error/10 text-error",
  neutral: "border-base-300 bg-base-200 text-base-content/80",
}

// Compact tinted note for inline field feedback (an icon plus a short message).
export const InlineNote = ({
  tone,
  icon: Icon,
  className = "",
  children,
}: {
  tone: InlineNoteTone
  icon: ComponentType<SVGProps<SVGSVGElement>>
  className?: string
  children: ReactNode
}) => (
  <div
    className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm ${TONE_CLASS[tone]} ${className}`}
  >
    <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <div>{children}</div>
  </div>
)

// Inline monospace chip readable inside an InlineNote's tinted background.
// children is optional so it can serve as a <Trans> component tag, where the
// translated content is injected by react-i18next.
export const InlineCode = ({ children }: { children?: ReactNode }) => (
  <code dir="ltr" className="rounded bg-black/10 px-1 text-xs">
    {children}
  </code>
)

// Matches bare http(s) URLs so GitHub's own error text (which embeds docs links
// like ".../restricting-access-to-your-organization-s-data/") renders them as
// clickable anchors. A trailing sentence period is a common false positive, so
// it (and other trailing punctuation) is trimmed back out of the match.
const URL_PATTERN = /(https?:\/\/[^\s]+)/g
const TRAILING_PUNCTUATION = /[.,;:)\]}>'"]+$/

// Render `text` with any embedded http(s) URLs turned into anchors. Used for
// relayed third-party (GitHub) messages we don't control, so a docs link in the
// text is clickable rather than plain italic. Non-URL segments pass through
// verbatim.
export const AutoLinkText = ({ text }: { text: string }) => {
  const parts = text.split(URL_PATTERN)
  return (
    <>
      {parts.map((part, i) => {
        // Odd indices are the capture-group URL segments.
        if (i % 2 === 0) return part
        const trailing = part.match(TRAILING_PUNCTUATION)?.[0] ?? ""
        const href = trailing ? part.slice(0, -trailing.length) : part
        return (
          <span key={i}>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {href}
            </a>
            {trailing}
          </span>
        )
      })}
    </>
  )
}
