import type { ReactNode } from "react"

import { Button } from "./Button"
import { DropdownMenu } from "./DropdownMenu"
import { TriangleDownIcon } from "./icons"

// A primary action with a caret that opens secondary actions beside it (the
// "New assignment ▾" and "Upload roster ▾" toolbar controls). The caller
// renders the primary control (a Button or RouterButton with `join-item`) and
// the menu items; this owns the join chrome, the caret button, and the menu.
//
// The caret's wrapper is deliberately NOT a join-item: daisyUI's join rounds
// its direct children, and the dropdown wrapper would take the rounding instead
// of the caret button inside it. The negative margin closes the 1px seam that
// leaves, and the inset border draws the divider the join would have drawn.
export function SplitButton({
  primary,
  caretLabel,
  disabled = false,
  size = "sm",
  children,
}: {
  primary: ReactNode
  caretLabel: string
  disabled?: boolean
  size?: "sm" | "md"
  children: ReactNode
}) {
  return (
    <div className="join">
      {primary}
      <div className="dropdown dropdown-end -ms-px">
        <Button
          variant="primary"
          size={size}
          tabIndex={0}
          disabled={disabled}
          className="join-item h-full border-s border-primary-content/20 px-2"
          aria-label={caretLabel}
        >
          <TriangleDownIcon aria-hidden="true" className="size-4" />
        </Button>
        <DropdownMenu className="w-max">{children}</DropdownMenu>
      </div>
    </div>
  )
}
