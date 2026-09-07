import { useEffect, useRef, useState } from "react"
import { useMutationState } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"

import { InlineSpinner } from "@/components/ui"
import { useAnnounce } from "@/hooks/useAnnounce"
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
// your behalf" beside the green read bar. Announcements go through the app's
// persistent live region and the visible pill is decorative. These passes
// swallow their own errors, so completion says "failed" when one did rather
// than claiming a sync.
export function BackgroundPassTag() {
  const { t } = useTranslation()
  const passes = useMutationState({
    filters: { predicate: isBackgroundPass },
    select: (mutation) => ({
      id: mutation.mutationId,
      status: mutation.state.status,
      // Paused (offline, or queued behind a scope) means the pass has not
      // started, so there is nothing to show or hold the tab for.
      paused: mutation.state.isPaused,
    }),
  })
  const pending = passes.filter(
    (p) => p.status === "pending" && !p.paused,
  ).length

  // Settled passes stay in the mutation cache for gcTime, so the verdict must
  // ignore ones from an earlier cycle, including a pass that failed before the
  // reveal fired. Only ids seen pending while the tag is shown count.
  const shownIds = useRef(new Set<number>())
  const [verdict, setVerdict] = useState<"synced" | "failed" | null>(null)
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearLinger = () => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current)
    lingerTimer.current = null
  }

  const visible = useRevealCycle(pending > 0, {
    showDelayMs: REVEAL_DELAY_MS,
    onSettle: () => {
      const failed = passes.some(
        (p) => shownIds.current.has(p.id) && p.status === "error",
      )
      shownIds.current.clear()
      clearLinger()
      setVerdict(failed ? "failed" : "synced")
      lingerTimer.current = setTimeout(() => {
        lingerTimer.current = null
        setVerdict(null)
      }, DONE_LINGER_MS)
    },
  })
  useEffect(() => {
    if (!visible) return
    for (const pass of passes) {
      if (pass.status === "pending" && !pass.paused) {
        shownIds.current.add(pass.id)
      }
    }
  }, [visible, passes])
  useEffect(() => clearLinger, [])

  // "Syncing" follows the visible state, not the reveal callback, so a pass
  // that resumes inside the hide delay announces again.
  const announcement: Announcement =
    visible && pending > 0 ? "syncing" : (verdict ?? "idle")

  const liveText: Record<Announcement, string> = {
    idle: "",
    syncing: t("backgroundPass.syncing"),
    synced: t("backgroundPass.synced"),
    failed: t("backgroundPass.failed"),
  }
  useAnnounce(liveText[announcement])
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
  )
}
