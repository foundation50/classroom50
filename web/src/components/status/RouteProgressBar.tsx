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
// Render-loop / churn safety: the fill is a Motion value animated imperatively
// (no per-frame setState); React state holds only the coarse visible flag,
// flipped at most twice per load cycle. Crucially the effect does NOT clear the
// timers in a per-run cleanup — `fetching` changes on every query start/finish,
// so a staggered burst of reads (this app's norm) would otherwise keep clearing
// and rescheduling the show-timer and the bar would never appear. Instead each
// timer is armed once per transition (guarded by its ref) and only cleared on
// unmount, so the 120ms reveal survives fetch-count churn.
const SHOW_DELAY_MS = 120
const HIDE_DELAY_MS = 180

export function RouteProgressBar() {
  const active = useIsFetching() > 0
  const [visible, setVisible] = useState(false)
  const progress = useMotionValue(0)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (active) {
      // A new load (or a resumed one): cancel any pending fade-out.
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      // Arm the reveal once. The show-timer ref guard means later `active`
      // re-runs during the same load don't reset the 120ms delay, so a
      // churny multi-fetch page still reveals the bar on schedule.
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
      return
    }

    // Fetches settled: cancel a pending (not-yet-shown) reveal outright.
    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
    // Complete + fade a shown bar, armed once via the hide-timer ref guard.
    if (visible && !hideTimer.current) {
      animate(progress, 1, { duration: 0.2, ease: EASE_OUT })
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        setVisible(false)
        progress.set(0)
      }, HIDE_DELAY_MS)
    }
  }, [active, visible, progress])

  // Clear timers only on unmount — never in a per-run cleanup (see above).
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

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
