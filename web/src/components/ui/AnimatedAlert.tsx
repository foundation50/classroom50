import type { ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"

import { collapseVariants } from "@/lib/motion"
import { Alert, type AlertProps } from "./Alert"

// The <Alert> primitive that animates its own mount/unmount. State-toggled
// alerts (`show` flips on a mutation result) otherwise snap in and out and jerk
// the content below them; this height-collapses on exit — the same
// collapseVariants + AnimatePresence recipe as AppBanner — so the surrounding
// layout reflows smoothly. The alert itself is an unchanged <Alert>, wrapped in
// a padding-free `overflow-hidden` collapser (padding on the collapsing element
// would keep a sliver visible at height 0). For always-rendered alerts (no
// enter/exit moment) use <Alert> directly.

export type AnimatedAlertProps = {
  // Toggles the alert; false animates it out rather than unmounting abruptly.
  show: boolean
  children?: ReactNode
} & AlertProps

export function AnimatedAlert({
  show,
  children,
  ...alertProps
}: AnimatedAlertProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          variants={collapseVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="overflow-hidden"
        >
          <Alert {...alertProps}>{children}</Alert>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default AnimatedAlert
