import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import { Button } from "@/components/ui"
import { collapseVariants } from "@/lib/motion"

// Per-row action warnings (keyed by row.key so one action's warning can't
// clobber another's), each dismissable. Animated in/out so a resolved warning
// collapses rather than snapping away.
export const RosterWarnings = ({
  warnings,
  onDismiss,
}: {
  warnings: Record<string, string>
  onDismiss: (key: string) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="flex w-full flex-col gap-2">
      <AnimatePresence initial={false}>
        {Object.entries(warnings).map(([key, warning]) => (
          // Audited exemption to the collapse-overflow guard: the list's
          // per-item exit animation needs AnimatePresence here, so <Collapse>
          // (with its own AnimatePresence) wouldn't see the removal. The
          // permanent clip is safe because the alert paints no overlay outside
          // its box.
          // eslint-disable-next-line no-restricted-syntax
          <motion.div
            key={key}
            layout
            variants={collapseVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div role="alert" className="alert alert-warning alert-soft">
              <span className="text-sm">{warning}</span>
              <Button variant="ghost" size="xs" onClick={() => onDismiss(key)}>
                {t("students.dismiss")}
              </Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
