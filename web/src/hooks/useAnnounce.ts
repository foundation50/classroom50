import { useEffect, useRef } from "react"

import {
  addAnnouncement,
  removeAnnouncement,
  updateAnnouncement,
} from "@/lib/liveAnnouncer"

// Announce `text` through the app's persistent live region for as long as the
// caller is mounted with a non-empty value. Pass an empty string or null to
// withdraw without unmounting.
export function useAnnounce(text: string | null | undefined): void {
  const id = useRef<number | null>(null)
  useEffect(() => {
    if (!text) {
      if (id.current !== null) {
        removeAnnouncement(id.current)
        id.current = null
      }
      return
    }
    if (id.current === null) id.current = addAnnouncement(text)
    else updateAnnouncement(id.current, text)
  }, [text])
  useEffect(
    () => () => {
      if (id.current !== null) removeAnnouncement(id.current)
    },
    [],
  )
}

export default useAnnounce
