import type { MouseEvent, ReactNode } from "react"
import { CheckIcon, CopyIcon } from "@primer/octicons-react"

import { Button } from "./Button"
import { cx } from "./cx"

// A copyable code/URL row: a bordered `bg-base-200` surface showing a monospace
// value with a copy Button that swaps to a check while `copied`. Clipboard state
// stays caller-owned (via useCopyToClipboard) so each instance tracks its own
// copy and its own revert timing — the primitive is stateless. Replaces the
// hand-rolled copy blocks scattered across the app.
//
// `copiedLabel` opts into a text button (icon + label, plus an aria-live
// announcement) over the compact icon-only default — use it where the copy is
// the primary action so success reads clearly, not just as a color swap.

export type CopyableCodeProps = {
  value: string
  copied: boolean
  onCopy: (e: MouseEvent<HTMLButtonElement>) => void
  label: string
  // Resting label is `label`; while copied the button reads `copiedLabel`.
  copiedLabel?: string
  className?: string
  children?: ReactNode
}

export function CopyableCode({
  value,
  copied,
  onCopy,
  label,
  copiedLabel,
  className,
  children,
}: CopyableCodeProps) {
  const withText = copiedLabel !== undefined
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
        shape={withText ? undefined : "square"}
        className="me-2 shrink-0"
        onClick={onCopy}
        aria-label={label}
        title={label}
      >
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-4" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-4" />
        )}
        {withText ? (copied ? copiedLabel : label) : null}
      </Button>
      {withText ? (
        <span aria-live="polite" className="sr-only">
          {copied ? copiedLabel : ""}
        </span>
      ) : null}
    </div>
  )
}

export default CopyableCode
