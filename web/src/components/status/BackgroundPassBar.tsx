import { useIsMutating } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"

import { TopProgressBar } from "./TopProgressBar"

export const isBackgroundPass = (mutation: Mutation) =>
  mutation.options.meta?.backgroundPass === true

// The write-side bar for the convergent passes the app runs on its own (roster
// and classroom reconciles): a pass fires on page entry with no button, so this
// is the only thing telling the viewer why the tab now asks before closing.
// Blue (info) so it reads as distinct from the green read-side load bar, which
// paints over it while both run.
export function BackgroundPassBar() {
  const pending = useIsMutating({ predicate: isBackgroundPass })
  return <TopProgressBar active={pending > 0} className="z-[59] bg-info" />
}
