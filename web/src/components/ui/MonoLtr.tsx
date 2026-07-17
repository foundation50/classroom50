import type { ReactNode } from "react"

import { cx } from "./cx"

// An LTR-isolated monospace run (repo names, @usernames, URLs, CLI commands)
// for use inside translated copy — e.g. as a <Trans> component tag. dir="ltr"
// both isolates the run from surrounding RTL text (HTML gives dir'd inline
// elements unicode-bidi: isolate) and fixes the internal ordering of neutral
// characters like "/", "-", "@". Explicit ltr beats <bdi>'s first-strong
// detection for identifiers that may start with RTL characters.

export type MonoLtrProps = {
  className?: string
  children?: ReactNode
}

export function MonoLtr({ className, children }: MonoLtrProps) {
  return (
    <span dir="ltr" className={cx("font-mono", className)}>
      {children}
    </span>
  )
}

export default MonoLtr
