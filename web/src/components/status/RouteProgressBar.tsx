import { useIsFetching } from "@tanstack/react-query"
import { TopProgressBar } from "./TopProgressBar"

// The read-side load bar, bound to React Query's global in-flight fetch count.
// This app fetches data in components (no route loaders), so the router has no
// pending phase to hook — the fetch count is the real "page is loading" signal.
// Paints over BackgroundPassBar when both run: a page load already says
// something is happening, and the blue bar takes the slot once reads settle.
export function RouteProgressBar() {
  return (
    <TopProgressBar
      active={useIsFetching() > 0}
      className="z-[60] bg-primary"
    />
  )
}
