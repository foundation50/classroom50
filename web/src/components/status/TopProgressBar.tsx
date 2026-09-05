import { useEffect, useRef, useState } from "react"
import {
  AnimatePresence,
  motion,
  useMotionValue,
  animate,
  type AnimationPlaybackControls,
} from "motion/react"
import { cx } from "@/components/ui"
import { EASE_OUT } from "@/lib/motion"

// Reveal/settle timing shared by the top-of-viewport indicators
// (RouteProgressBar, BackgroundPassTag). Each binds `active` to its own React
// Query counter; this owns the anti-flash reveal delay and the settle delay
// before hiding, and reports the transitions so a bar can drive its own fill.
//
// Churn safety: React state holds only the coarse visible flag, flipped at most
// twice per cycle. Crucially the effect does NOT clear the timers in a per-run
// cleanup — `active` flips on every query start/finish, so a staggered burst of
// reads (this app's norm) would otherwise keep clearing and rescheduling the
// show-timer and the bar would never appear. Instead each timer is armed once
// per transition (guarded by its ref) and only cleared on unmount, so the 120ms
// reveal survives count churn.
const SHOW_DELAY_MS = 120
const HIDE_DELAY_MS = 180

type RevealTransitions = {
  // The bar just became visible.
  onShow?: () => void
  // `active` dropped while visible; the bar hides after the settle delay.
  onSettle?: () => void
  // The bar just hid.
  onHide?: () => void
}

export function useRevealCycle(
  active: boolean,
  transitions: RevealTransitions = {},
): boolean {
  const [visible, setVisible] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Timers fire well after the render that armed them; read the latest
  // callbacks through a ref so a bar can pass inline closures.
  const on = useRef(transitions)
  useEffect(() => {
    on.current = transitions
  })

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
          setVisible(true)
          on.current.onShow?.()
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
      on.current.onSettle?.()
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        setVisible(false)
        on.current.onHide?.()
      }, HIDE_DELAY_MS)
    }
  }, [active, visible])

  // Clear timers only on unmount — never in a per-run cleanup (see above),
  // which would defeat the churn-proof reveal.
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  return visible
}

// The top slot both indicators pin to: `className` carries the color and
// stacking layer, and the caller decides which one paints over the other.
export const topBarClass = (className: string) =>
  cx("fixed inset-x-0 top-0", className)

// A determinate-looking trickle: fills toward ~90% while `active`, then snaps
// to 100% and fades, mimicking a native app's route load. The fill is a Motion
// value animated imperatively (no per-frame setState).
export function TopProgressBar({
  active,
  className,
}: {
  active: boolean
  className: string
}) {
  const progress = useMotionValue(0)
  // The running fill tween, held so unmount can stop its frame loop.
  const anim = useRef<AnimationPlaybackControls | null>(null)
  const visible = useRevealCycle(active, {
    onShow: () => {
      progress.set(0.08)
      // Trickle toward 90% — never reaches 100% until it settles, so a long
      // request keeps advancing without ever "finishing" early.
      anim.current = animate(progress, 0.9, { duration: 8, ease: EASE_OUT })
    },
    onSettle: () => {
      anim.current = animate(progress, 1, { duration: 0.2, ease: EASE_OUT })
    },
    onHide: () => progress.set(0),
  })
  useEffect(() => () => anim.current?.stop(), [])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={topBarClass(cx("h-0.5 origin-left", className))}
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
