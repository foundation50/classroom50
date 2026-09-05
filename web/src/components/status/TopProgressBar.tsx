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

// Anti-flash reveal and settle timing shared by the top-of-viewport indicators.
// The timers are armed once per transition and cleared only on unmount, never
// in a per-run cleanup: `active` flips on every query start/finish, and a
// cleanup would keep rescheduling the reveal so the bar never appears.
const SHOW_DELAY_MS = 120
const HIDE_DELAY_MS = 180

type RevealOptions = {
  // Default suits the route bar; a self-started process should wait ~1s
  // (Primer: no loading state for a sub-second wait).
  showDelayMs?: number
  onShow?: () => void
  // `active` dropped while visible; the bar hides after the settle delay.
  onSettle?: () => void
  onHide?: () => void
}

export function useRevealCycle(
  active: boolean,
  options: RevealOptions = {},
): boolean {
  const { showDelayMs = SHOW_DELAY_MS } = options
  const [visible, setVisible] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest callbacks, so timers armed by an older render call current closures.
  const on = useRef(options)
  useEffect(() => {
    on.current = options
  })

  useEffect(() => {
    if (active) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      if (!visible && !showTimer.current) {
        showTimer.current = setTimeout(() => {
          showTimer.current = null
          setVisible(true)
          on.current.onShow?.()
        }, showDelayMs)
      }
      return
    }

    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
    if (visible && !hideTimer.current) {
      on.current.onSettle?.()
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        setVisible(false)
        on.current.onHide?.()
      }, HIDE_DELAY_MS)
    }
  }, [active, visible, showDelayMs])

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  return visible
}

// Both indicators share the top slot; `className` sets color and z-order.
export const topBarClass = (className: string) =>
  cx("fixed inset-x-0 top-0", className)

// Trickles toward 90% while `active`, then snaps to 100% and fades. The fill
// is a Motion value animated imperatively, so no per-frame setState.
export function TopProgressBar({
  active,
  className,
}: {
  active: boolean
  className: string
}) {
  const progress = useMotionValue(0)
  const anim = useRef<AnimationPlaybackControls | null>(null)
  const visible = useRevealCycle(active, {
    onShow: () => {
      progress.set(0.08)
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
