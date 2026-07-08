import type { MouseEvent, ReactNode } from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "./Button"
import { cx } from "./cx"

// A copyable code/URL row: a bordered `bg-base-200` surface showing a monospace
// value with a copy Button that swaps to a check while `copied`. Clipboard state
// stays caller-owned (via useCopyToClipboard) so each instance tracks its own
// copy and its own revert timing — the primitive is stateless. Replaces the
// hand-rolled copy blocks scattered across the app.

export type CopyableCodeProps = {
  value: string
  copied: boolean
  onCopy: (e: MouseEvent<HTMLButtonElement>) => void
  label: string
  className?: string
  children?: ReactNode
}

export function CopyableCode({
  value,
  copied,
  onCopy,
  label,
  className,
  children,
}: CopyableCodeProps) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-2 rounded-box border border-base-300 bg-base-200 text-base-content",
        className,
      )}
    >
      <pre className="overflow-x-auto px-4 py-3 text-sm">
        <code>{children ?? value}</code>
      </pre>
      <Button
        variant={copied ? "success" : "ghost"}
        size="sm"
        shape="square"
        className="mr-2 shrink-0"
        onClick={onCopy}
        aria-label={label}
        title={label}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-4" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
      </Button>
    </div>
  )
}

export default CopyableCode
