import { AnimatePresence, motion } from "motion/react"
import { useState, type ReactNode } from "react"
import { crossFade } from "./motion"

/**
 * Cross-fades a loading fallback with resolved content. Renders `fallback`
 * while `loading`, else `children`, with Motion fading out->in (`mode="wait"`).
 *
 * Keyed on the loading boolean so it fires once on the load->resolved boundary,
 * not on subsequent content re-renders. Honors reduced motion via the app-level
 * MotionConfig.
 *
 * `deferUntilLoaded` opts a caller out of the AnimatePresence machinery until
 * the first loading->resolved boundary: a swap that has never been loading
 * renders `children` bare. Off by default so existing callers keep their
 * wrapper (and `className`); on for callers that mount many already-resolved
 * instances that only rarely load (one per table row).
 */
export function LoadingSwap({
  loading,
  fallback,
  children,
  className,
  deferUntilLoaded = false,
}: {
  loading: boolean
  fallback: ReactNode
  children: ReactNode
  className?: string
  deferUntilLoaded?: boolean
}) {
  // Latch whether loading was ever true: before the first load there's no
  // boundary to cross-fade, so a deferring caller can skip AnimatePresence.
  const [everLoaded, setEverLoaded] = useState(loading)
  if (loading && !everLoaded) setEverLoaded(true)
  if (deferUntilLoaded && !everLoaded) {
    return className ? (
      <div className={className}>{children}</div>
    ) : (
      <>{children}</>
    )
  }
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
