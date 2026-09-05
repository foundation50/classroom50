import { useEffect, useRef, useState } from "react"
import { useMutationState } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"

import { InlineSpinner } from "@/components/ui"
import { topBarClass, useRevealCycle } from "./TopProgressBar"

export const isBackgroundPass = (mutation: Mutation) =>
  mutation.options.meta?.backgroundPass === true

// Primer: no loading state for a sub-second wait.
const REVEAL_DELAY_MS = 1000
// Completion text clears so the next pass's "syncing" announces afresh.
const DONE_LINGER_MS = 5000

type Announcement = "idle" | "syncing" | "synced" | "failed"

// Spinner + label for a `backgroundPass` mutation the app started itself: the
// only in-page cause for the leave prompt those passes raise. Indeterminate
// because a reconcile's length is unknown; warning-toned to read as "writing on
// your behalf" beside the green read bar. The live region is always mounted
// (one inserted on demand is often not announced) and the visible pill is
// decorative. These passes swallow their own errors, so completion says
// "failed" when one did rather than claiming a sync.
export function BackgroundPassTag() {
  const { t } = useTranslation()
  const passes = useMutationState({
    filters: { predicate: isBackgroundPass },
    select: (mutation) => ({
      id: mutation.mutationId,
      status: mutation.state.status,
    }),
  })
  const pending = passes.filter((p) => p.status === "pending").length

  const [announcement, setAnnouncement] = useState<Announcement>("idle")
  // Ids shown this cycle, so the verdict ignores older settled passes still in
  // the cache. Declared before the reveal hook so its effect runs first.
  const shownIds = useRef(new Set<number>())
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    for (const pass of passes) {
      if (pass.status === "pending") shownIds.current.add(pass.id)
    }
  }, [passes])

  const visible = useRevealCycle(pending > 0, {
    showDelayMs: REVEAL_DELAY_MS,
    onShow: () => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
      setAnnouncement("syncing")
    },
    onSettle: () => {
      const failed = passes.some(
        (p) => shownIds.current.has(p.id) && p.status === "error",
      )
      shownIds.current.clear()
      setAnnouncement(failed ? "failed" : "synced")
      clearTimer.current = setTimeout(() => {
        clearTimer.current = null
        setAnnouncement("idle")
      }, DONE_LINGER_MS)
    },
  })
  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
    },
    [],
  )

  const liveText: Record<Announcement, string> = {
    idle: "",
    syncing: t("backgroundPass.syncing"),
    synced: t("backgroundPass.synced"),
    failed: t("backgroundPass.failed"),
  }
  return (
    <>
      <span role="status" className="sr-only">
        {liveText[announcement]}
      </span>
      <AnimatePresence>
        {visible && (
          <motion.div
            className={topBarClass(
              "z-[59] flex justify-center pointer-events-none",
            )}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
            aria-hidden="true"
          >
            <span className="inline-flex items-center gap-1.5 rounded-b-box bg-warning px-2.5 py-1 text-xs font-medium text-warning-content shadow-sm">
              {/* The tag's reveal already served the anti-flash delay. */}
              <InlineSpinner immediate />
              {t("backgroundPass.syncing")}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
