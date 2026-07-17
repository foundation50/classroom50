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
          <motion.div
            key={key}
            layout
            variants={collapseVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            role="alert"
            className="alert alert-warning alert-soft overflow-hidden"
          >
            <span className="text-sm">{warning}</span>
            <Button variant="ghost" size="xs" onClick={() => onDismiss(key)}>
              {t("students.dismiss")}
            </Button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
