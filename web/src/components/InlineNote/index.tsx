import type { ComponentType, ReactNode, SVGProps } from "react"

export type InlineNoteTone = "success" | "warning" | "error" | "neutral"

// Explicit dark-on-light colors rather than daisyUI's *-content tones, too light
// to read on a white form background.
const TONE_CLASS: Record<InlineNoteTone, string> = {
  success: "bg-green-50 border-green-200 text-green-800",
  warning: "bg-amber-50 border-amber-200 text-amber-900",
  error: "bg-red-50 border-red-200 text-red-800",
  neutral: "bg-base-200 border-base-300 text-base-content/80",
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
export const InlineCode = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-black/10 px-1 text-xs">{children}</code>
)
