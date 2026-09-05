import { useSyncExternalStore } from "react"

import {
  getLiveAnnouncement,
  subscribeLiveAnnouncer,
} from "@/lib/liveAnnouncer"

// The one polite live region for presence-shaped status (spinners, background
// passes). Mounted once in main.tsx from first paint, empty while idle, so the
// text change is what assistive tech hears rather than the region appearing.
export function LiveAnnouncer() {
  const text = useSyncExternalStore(
    subscribeLiveAnnouncer,
    getLiveAnnouncement,
    getLiveAnnouncement,
  )
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {text}
    </div>
  )
}
