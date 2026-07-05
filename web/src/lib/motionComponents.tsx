import { motion } from "motion/react"
import type { ComponentPropsWithoutRef } from "react"
import { calloutVariants, enterExit, rowHover } from "./motion"

// Reusable Motion wrappers replacing the per-element CSS animation utilities
// (animate-enter, animate-callout, clickable-row), keeping call sites terse and
// animations consistent. All honor reduced motion via the app-level MotionConfig.
//
// The global `.btn` press feedback and `skeleton-shimmer` intentionally stay as
// CSS utilities in index.css — they apply broadly (every button, every skeleton)
// where a single CSS rule beats a per-site Motion wrapper.

type DivProps = ComponentPropsWithoutRef<typeof motion.div>

/** Scale-up + fade-in entrance for cards, content, and grids. */
export function EnterDiv({ children, ...props }: DivProps) {
  return (
    <motion.div
      variants={enterExit}
      initial="initial"
      animate="animate"
      {...props}
    >
      {children}
    </motion.div>
  )
}

/** Slide-down + fade entrance for notice/alert-style callouts. */
export function CalloutDiv({ children, ...props }: DivProps) {
  return (
    <motion.div
      variants={calloutVariants}
      initial="initial"
      animate="animate"
      {...props}
    >
      {children}
    </motion.div>
  )
}

/** Slide-down + fade entrance for a callout rendered as a paragraph. */
export function CalloutText({
  children,
  ...props
}: ComponentPropsWithoutRef<typeof motion.p>) {
  return (
    <motion.p
      variants={calloutVariants}
      initial="initial"
      animate="animate"
      {...props}
    >
      {children}
    </motion.p>
  )
}

/** Clickable list row with a subtle hover lift + shadow. */
export function ClickableRow({
  children,
  ...props
}: ComponentPropsWithoutRef<typeof motion.li>) {
  return (
    <motion.li
      whileHover={rowHover.whileHover}
      transition={rowHover.transition}
      {...props}
    >
      {children}
    </motion.li>
  )
}
