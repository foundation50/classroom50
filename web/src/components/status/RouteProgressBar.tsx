import { useEffect, useRef, useState } from "react"
import { useIsFetching } from "@tanstack/react-query"
import { AnimatePresence, motion, useMotionValue, animate } from "motion/react"
import { EASE_OUT } from "@/lib/motion"

// A thin top-of-viewport progress bar bound to React Query's global in-flight
// count. This app fetches data in components (no route loaders), so the router
// has no pending phase to hook — the fetch count is the real "page is loading"
// signal. The bar trickles toward ~90% while fetches are in flight, then snaps
// to 100% and fades out when they settle, mimicking a native app's route load.
//
// Care taken against render loops: the fill is a Motion value animated
// imperatively (no per-frame setState); React state holds only the coarse
// visible/hidden flag, flipped at most twice per load cycle. A short show-delay
// keeps a burst of cached reads from flashing the bar.
const SHOW_DELAY_MS = 120
const HIDE_DELAY_MS = 180

export function RouteProgressBar() {
  const fetching = useIsFetching()
  const [visible, setVisible] = useState(false)
  const progress = useMotionValue(0)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearTimers = () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      showTimer.current = null
      hideTimer.current = null
    }

    if (fetching > 0) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      // Delay the reveal so instant cache hits don't flash a bar.
      if (!visible && !showTimer.current) {
        showTimer.current = setTimeout(() => {
          showTimer.current = null
          progress.set(0.08)
          setVisible(true)
          // Trickle toward 90% — never reaches 100% until fetches settle, so a
          // long request keeps advancing without ever "finishing" early.
          animate(progress, 0.9, { duration: 8, ease: EASE_OUT })
        }, SHOW_DELAY_MS)
      }
      return clearTimers
    }

    // Fetches settled: cancel a pending reveal, or complete + fade a shown bar.
    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
    if (visible && !hideTimer.current) {
      animate(progress, 1, { duration: 0.2, ease: EASE_OUT })
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        setVisible(false)
        progress.set(0)
      }, HIDE_DELAY_MS)
    }
    return clearTimers
  }, [fetching, visible, progress])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-primary"
          style={{ scaleX: progress }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          aria-hidden="true"
        />
      )}
    </AnimatePresence>
  )
}
