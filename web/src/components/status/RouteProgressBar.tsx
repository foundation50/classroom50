import { useIsFetching } from "@tanstack/react-query"
import { TopProgressBar } from "./TopProgressBar"

// The read-side load bar. Pages fetch in components (no route loaders), so the
// global fetch count is the real "page is loading" signal.
export function RouteProgressBar() {
  return (
    <TopProgressBar
      active={useIsFetching() > 0}
      className="z-[60] bg-primary"
    />
  )
}
