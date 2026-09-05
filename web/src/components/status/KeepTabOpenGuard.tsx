import { useIsMutating } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"

import { useBeforeUnloadGuard } from "@/hooks/useBeforeUnloadGuard"

export const holdsTabOpen = (mutation: Mutation) =>
  mutation.options.meta?.keepTabOpen === true

// Holds the tab (browser confirm on close, reload, or external navigation)
// while any mutation flagged `meta: { keepTabOpen: true }` is pending. Bound to
// the mutation cache rather than a page's `isPending` so the hold outlives the
// component that started the write: a multi-step chain keeps running through
// in-app navigation, and only a closed tab kills it. Mounted once, next to
// RouteProgressBar, which binds the same way to the query side.
export function KeepTabOpenGuard() {
  const pending = useIsMutating({ predicate: holdsTabOpen })
  useBeforeUnloadGuard(pending > 0)
  return null
}
