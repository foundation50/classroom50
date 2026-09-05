import { useIsMutating } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"

import { InlineSpinner } from "@/components/ui"
import { topBarClass, useRevealCycle } from "./TopProgressBar"

export const isBackgroundPass = (mutation: Mutation) =>
  mutation.options.meta?.backgroundPass === true

// A small tag hanging from the top edge while one of the convergent passes the
// app runs on its own (roster and classroom reconciles) is pending. A pass
// fires on page entry with no button, so this is the only thing telling the
// viewer why the tab now asks before closing. Spinner plus label rather than a
// progress bar: a reconcile's length is unknowable up front, and a fill parked
// at 10% that then jumps to done reads as a hang. Warning-toned so it reads as
// "the app is writing on your behalf", apart from the green read-side load
// bar, which paints over the tag's top edge while both run.
export function BackgroundPassTag() {
  const { t } = useTranslation()
  const pending = useIsMutating({ predicate: isBackgroundPass })
  const visible = useRevealCycle(pending > 0)
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={topBarClass(
            "z-[59] flex justify-center pointer-events-none",
          )}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
        >
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-b-box bg-warning px-2.5 py-1 text-xs font-medium text-warning-content shadow-sm"
          >
            {/* The tag's own reveal already waited out the anti-flash window. */}
            <InlineSpinner immediate />
            {t("backgroundPass.syncing")}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
