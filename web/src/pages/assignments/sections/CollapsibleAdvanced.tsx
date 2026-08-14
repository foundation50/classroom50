import { useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import { collapseVariants } from "@/lib/motion"
import { cx } from "@/components/ui"
import { useRevealOnExpand } from "@/hooks/useRevealOnExpand"

// The collapsible "Advanced settings" disclosure shared by the Repository Setup
// and autograder panes. One recipe, one source — both render through this so the
// chevron/heading treatment can't drift. Deliberately compact and info-colored
// rather than heading-sized: it's a secondary affordance the common path skips.
//
// A button + AnimatePresence rather than native <details>/<summary>: the browser
// display-toggles a <details> body, so its height can't be animated. This shares
// the app's collapseVariants with every other expanding surface.
export function CollapsibleAdvanced({
  help,
  children,
}: {
  help?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const { bodyRef, reveal } = useRevealOnExpand()
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          const next = !expanded
          setExpanded(next)
          if (next) reveal()
        }}
        aria-expanded={expanded}
        className="group flex w-fit cursor-pointer items-center gap-1.5 text-sm font-semibold text-info hover:underline"
      >
        {/* Nudges right while closed and down once open, so the hover hints at
            the direction the panel will move. */}
        <ChevronRight
          aria-hidden="true"
          className={cx(
            "size-4 transition-transform duration-200",
            expanded
              ? "rotate-90 group-hover:translate-y-0.5"
              : "group-hover:translate-x-0.5",
          )}
        />
        {t("assignments.form.advanced")}
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            ref={bodyRef}
            variants={collapseVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            {help ? (
              <p className="pt-2 pb-4 text-sm text-base-content/70">{help}</p>
            ) : (
              <div className="pt-2" />
            )}
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
