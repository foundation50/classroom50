import { useEffect, useRef, useState } from "react"
import { useMutationState } from "@tanstack/react-query"
import type { Mutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"

import { InlineSpinner } from "@/components/ui"
import { topBarClass, useRevealCycle } from "./TopProgressBar"

export const isBackgroundPass = (mutation: Mutation) =>
  mutation.options.meta?.backgroundPass === true

// Primer: don't show a loading state for a sub-second wait. A pass that
// finishes inside this window never surfaces, visually or to a screen reader.
const REVEAL_DELAY_MS = 1000
// How long the completion text stays in the live region before it clears, so
// the next pass's "syncing" is a fresh change that announces again.
const DONE_LINGER_MS = 5000

type Announcement = "idle" | "syncing" | "synced" | "failed"

// A small tag hanging from the top edge while one of the convergent passes the
// app runs on its own (roster and classroom reconciles) is pending. A pass
// fires on page entry with no button, so this is the only thing telling the
// viewer why the tab now asks before closing. Spinner plus label rather than a
// progress bar: a reconcile's length is unknowable up front, and a fill parked
// at 10% that then jumps to done reads as a hang. Warning-toned so it reads as
// "the app is writing on your behalf", apart from the green read-side load
// bar, which paints over the tag's top edge while both run.
//
// Accessibility follows Primer's loading pattern: the `role="status"` element
// is always rendered (a live region inserted on demand is often not announced)
// and carries the lifecycle, start through completion, while the visible pill
// is decorative. Completion is truthful: these passes are best-effort and swallow
// their own errors, so a pass that failed says so rather than claiming a sync.
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
  // Passes that were in flight during this visible cycle, so the completion
  // verdict covers exactly the work the tag showed and not an older, already
  // settled pass still sitting in the cache. Declared before the reveal hook so
  // this effect runs first and a same-commit settle sees the ids.
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

  // A pass that finished inside the reveal delay never announced a start, so
  // it must not announce an end either; `visible` gates both.
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
              {/* The tag's own reveal already waited out the anti-flash window. */}
              <InlineSpinner immediate />
              {t("backgroundPass.syncing")}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
