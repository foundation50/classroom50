import { useState, type ReactNode, type RefObject } from "react"
import { AnimatePresence, motion } from "motion/react"

import { collapseVariants } from "@/lib/motion"
import { cx } from "./cx"

// The canonical height-animated disclosure body. Wrap any content that expands
// and collapses; the caller owns the toggle and the `open` boolean.
//
// Why this exists rather than an inline motion.div: animating height REQUIRES
// `overflow: hidden` (content would otherwise spill out of the shrinking box),
// but that same rule CLIPS anything a child paints outside the box — tooltip
// bubbles, dropdown menus, focus rings. Clipping is therefore scoped to the
// animation itself: it applies while the height is in motion and is lifted the
// moment the open animation settles, so an expanded panel never truncates a
// child's overlay. Getting this wrong is invisible until a tooltip near an edge
// is cut in half, so it lives in exactly one place.
export function Collapse({
  open,
  bodyRef,
  className,
  children,
}: {
  open: boolean
  // Forwarded to the animating element, e.g. for useRevealOnExpand's measurement.
  bodyRef?: RefObject<HTMLDivElement | null>
  className?: string
  children: ReactNode
}) {
  // Clip only while a transition is in flight. Seeded false so a panel that
  // mounts already-open (AnimatePresence skips its enter animation, so no
  // completion callback ever fires) is never left permanently clipped.
  const [clip, setClip] = useState(false)
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          ref={bodyRef}
          variants={collapseVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onAnimationStart={() => setClip(true)}
          onAnimationComplete={(definition) => {
            if (definition === "animate") setClip(false)
          }}
          className={cx(clip && "overflow-hidden", className)}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default Collapse
