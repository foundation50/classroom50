import type { ReactNode } from "react"

import { cx, hasUtility } from "./cx"

// An LTR-isolated emphasized run for identifiers (org/classroom/assignment/
// repo names, logins) inside translated copy — the prose-weight sibling of
// MonoLtr, for <Trans> component tags where monospace would be wrong. dir="ltr"
// both isolates the run from surrounding RTL text (HTML gives dir'd inline
// elements unicode-bidi: isolate) and fixes the internal ordering of neutral
// characters like "/", "-", "@". Do NOT use for human display names — those
// can legitimately be RTL script and must not be forced LTR.

export type EmphasisLtrProps = {
  className?: string
  children?: ReactNode
}

export function EmphasisLtr({ className, children }: EmphasisLtrProps) {
  // A caller-supplied weight (font-bold, font-medium) replaces the default
  // rather than fighting it — cx can't merge Tailwind classes and same-property
  // source order is unspecified.
  const weight = hasUtility("font-", className) ? false : "font-semibold"
  return (
    <span dir="ltr" className={cx(weight, className)}>
      {children}
    </span>
  )
}

export default EmphasisLtr
