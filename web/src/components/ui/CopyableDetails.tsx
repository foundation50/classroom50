import type { MouseEvent } from "react"
import { Check, ClipboardCopy } from "lucide-react"

import { Button } from "./Button"
import { cx } from "./cx"

// A collapsible, copyable diagnostics block: a <details>/<summary> disclosure
// wrapping a monospace <pre> of allow-listed text plus a copy Button that swaps
// to a check while `copied`, with an aria-live region announcing the copy.
// Clipboard state stays caller-owned (via useCopyToClipboard) so each instance
// tracks its own copy/revert timing — the primitive is stateless. Consolidates
// the hand-rolled copy-details blocks in AboutDialog and MembershipError.

export type CopyableDetailsProps = {
  // The full text shown in the <pre> and copied to the clipboard.
  text: string
  copied: boolean
  onCopy: (e: MouseEvent<HTMLButtonElement>) => void
  // Disclosure trigger label.
  summaryLabel: string
  // Copy Button label; swaps to `copiedLabel` while `copied`.
  copyLabel: string
  copiedLabel: string
  className?: string
  preClassName?: string
}

export function CopyableDetails({
  text,
  copied,
  onCopy,
  summaryLabel,
  copyLabel,
  copiedLabel,
  className,
  preClassName,
}: CopyableDetailsProps) {
  return (
    <details
      className={cx(
        "rounded-lg border border-base-300 bg-base-200/40 p-3 text-sm",
        className,
      )}
    >
      <summary className="cursor-pointer font-medium text-base-content">
        {summaryLabel}
      </summary>
      <div className="mt-3 space-y-3">
        <pre
          className={cx(
            "overflow-auto rounded-lg bg-base-100 p-3 text-xs whitespace-pre-wrap",
            preClassName,
          )}
        >
          {text}
        </pre>
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <ClipboardCopy aria-hidden="true" className="size-4" />
          )}
          {copied ? copiedLabel : copyLabel}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied ? copiedLabel : ""}
        </span>
      </div>
    </details>
  )
}

export default CopyableDetails
