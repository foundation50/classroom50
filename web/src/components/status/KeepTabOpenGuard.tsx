import { useIsMutating } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"

import { useBeforeUnloadGuard } from "@/hooks/useBeforeUnloadGuard"

export const holdsTabOpen = (mutation: Mutation) =>
  mutation.options.meta?.keepTabOpen === true

// Holds the tab while any `keepTabOpen` mutation is pending. Reads the mutation
// cache, not a page's `isPending`, so the hold outlives the page that started
// the write. Mounted once in main.tsx.
export function KeepTabOpenGuard() {
  const pending = useIsMutating({ predicate: holdsTabOpen })
  useBeforeUnloadGuard(pending > 0)
  return null
}
