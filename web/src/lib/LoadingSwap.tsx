import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"
import { crossFade } from "./motion"

/**
 * Cross-fades a loading fallback with resolved content. Renders `fallback`
 * while `loading`, else `children`, with Motion fading out->in (`mode="wait"`).
 *
 * Keyed on the loading boolean so it fires once on the load->resolved boundary,
 * not on subsequent content re-renders. Honors reduced motion via the app-level
 * MotionConfig.
 */
export function LoadingSwap({
  loading,
  fallback,
  children,
  className,
}: {
  loading: boolean
  fallback: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={loading ? "loading" : "loaded"}
        variants={crossFade}
        initial="initial"
        animate="animate"
        exit="exit"
        className={className}
        aria-busy={loading}
      >
        {loading ? fallback : children}
      </motion.div>
    </AnimatePresence>
  )
}
