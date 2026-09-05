import { useEffect, useRef, useState } from "react"
import {
  AnimatePresence,
  motion,
  useMotionValue,
  animate,
  type AnimationPlaybackControls,
  type MotionValue,
} from "motion/react"
import { cx } from "@/components/ui"
import { EASE_OUT } from "@/lib/motion"

// The thin top-of-viewport trickle bar shared by RouteProgressBar (reads) and
// BackgroundPassBar (background writes). Each binds `active` to its own React
// Query counter; this owns the reveal/trickle/complete/fade lifecycle. The bar
// trickles toward ~90% while `active`, then snaps to 100% and fades out when
// it settles, mimicking a native app's route load.
//
// Render-loop / churn safety: the fill is a Motion value animated imperatively
// (no per-frame setState); React state holds only the coarse visible flag,
// flipped at most twice per cycle. Crucially the effect does NOT clear the
// timers in a per-run cleanup — `active` flips on every query start/finish, so
// a staggered burst of reads (this app's norm) would otherwise keep clearing
// and rescheduling the show-timer and the bar would never appear. Instead each
// timer is armed once per transition (guarded by its ref) and only cleared on
// unmount, so the 120ms reveal survives count churn.
const SHOW_DELAY_MS = 120
const HIDE_DELAY_MS = 180

export function useTrickleProgress(active: boolean): {
  visible: boolean
  progress: MotionValue<number>
} {
  const [visible, setVisible] = useState(false)
  const progress = useMotionValue(0)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The running fill tween, held so unmount can stop its frame loop.
  const anim = useRef<AnimationPlaybackControls | null>(null)

  useEffect(() => {
    if (active) {
      // A new cycle (or a resumed one): cancel any pending fade-out.
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      // Arm the reveal once. The show-timer ref guard means later `active`
      // re-runs during the same cycle don't reset the 120ms delay, so a churny
      // multi-fetch page still reveals the bar on schedule.
      if (!visible && !showTimer.current) {
        showTimer.current = setTimeout(() => {
          showTimer.current = null
          progress.set(0.08)
          setVisible(true)
          // Trickle toward 90% — never reaches 100% until it settles, so a
          // long request keeps advancing without ever "finishing" early.
          anim.current = animate(progress, 0.9, { duration: 8, ease: EASE_OUT })
        }, SHOW_DELAY_MS)
      }
      return
    }

    // Settled: cancel a pending (not-yet-shown) reveal outright.
    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
    // Complete + fade a shown bar, armed once via the hide-timer ref guard.
    if (visible && !hideTimer.current) {
      anim.current = animate(progress, 1, { duration: 0.2, ease: EASE_OUT })
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        setVisible(false)
        progress.set(0)
      }, HIDE_DELAY_MS)
    }
  }, [active, visible, progress])

  // Clear timers and stop the fill tween only on unmount — never in a per-run
  // cleanup (see above), which would defeat the churn-proof reveal.
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      anim.current?.stop()
    },
    [],
  )

  return { visible, progress }
}

// `className` carries the color and stacking layer; both bars share the top
// slot, so the caller decides which one paints over the other.
export function TopProgressBar({
  active,
  className,
}: {
  active: boolean
  className: string
}) {
  const { visible, progress } = useTrickleProgress(active)
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={cx("fixed inset-x-0 top-0 h-0.5 origin-left", className)}
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
