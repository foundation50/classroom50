import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RotateCw,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { useActionActivity, type Tracker } from "@/hooks/useActionActivity"
import { useSidebarCollapsed } from "@/hooks/useSidebarCollapsed"
import { calloutVariants } from "@/lib/motion"

// Compact elapsed duration (e.g. "8s", "1m 12s", "3m"). Under a minute shows
// seconds; from a minute up shows m + s (s omitted once past ~an hour to stay
// short). Returns "" for a non-positive span.
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Elapsed time for a tracker: live-ticking since start while running, or the
// frozen total once finished. `now` is the shared 1s tick from the banner so
// running rows advance in step without each row owning a timer.
const ElapsedLabel = ({ tracker, now }: { tracker: Tracker; now: number }) => {
  if (tracker.startedAtMs === undefined) return null
  const end = tracker.endedAtMs ?? now
  const elapsed = formatElapsed(end - tracker.startedAtMs)
  if (!elapsed) return null
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums opacity-70">
      {elapsed}
    </span>
  )
}

// App-wide banner pinned to the top of the content area (right of the sidebar
// at lg+) showing GitHub Actions activity for the current org as a collection of
// per-operation trackers. Mounts above the router (alongside the toast viewport)
// so it survives route changes.
//
//  - One tracker: shown inline in the bar.
//  - Several: the most recent action leads the collapsed bar (aggregate tone —
//    red if anything failed) with a total-count badge; expanding reveals a
//    neutral list where each row carries its OWN phase color (green succeeded /
//    red failed / orange running) so it's clear what passed and what didn't.
//  - Each tracker reflects its run's real state; terminal rows (success and
//    failed) persist as run history until the teacher dismisses them.
//
// Router constraint: this renders ABOVE the RouterProvider, so it must NOT use a
// TanStack <Link>. Run links are plain <a href> to github.com.

// Icon for a tracker phase. `tinted` applies the phase's semantic color (used in
// the per-row list, which sits on a neutral surface); without it the icon
// inherits the current color (used in the solid-tone header).
const StatusIcon = ({
  phase,
  tinted,
}: {
  phase: Tracker["phase"]
  tinted?: boolean
}) => {
  if (phase === "failed")
    return (
      <AlertTriangle
        aria-hidden="true"
        className={`size-4 shrink-0 ${tinted ? "text-error" : ""}`}
      />
    )
  if (phase === "success")
    return (
      <CheckCircle2
        aria-hidden="true"
        className={`size-4 shrink-0 ${tinted ? "text-success" : ""}`}
      />
    )
  return (
    <Loader2
      aria-hidden="true"
      className={`size-4 shrink-0 animate-spin ${tinted ? "text-warning" : ""}`}
    />
  )
}

// Per-phase background/border/text for an expanded row, so a green (success),
// red (failed), or orange (running) row is clearly distinguishable inside the
// neutral list — even when the aggregate header is red.
const ROW_TONE: Record<Tracker["phase"], string> = {
  failed: "bg-error/10 text-error",
  success: "bg-success/10 text-success",
  running: "bg-warning/10 text-warning",
  pending: "bg-warning/10 text-warning",
}

const TrackerRow = ({
  tracker,
  onDismiss,
  onRetry,
  retrying,
  now,
  compact,
}: {
  tracker: Tracker
  onDismiss: (id: string) => void
  onRetry: (id: string) => void
  retrying: boolean
  now: number
  // compact = rendered inline in the collapsed single-tracker bar (inherits the
  // header's solid tone). Otherwise the row carries its own per-phase tone.
  compact?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <div
      className={`flex items-center gap-2 ${
        compact ? "" : `rounded-md px-2 py-1.5 ${ROW_TONE[tracker.phase]}`
      }`}
    >
      <StatusIcon phase={tracker.phase} tinted={!compact} />
      <span className="min-w-0 flex-1 truncate text-sm">{tracker.label}</span>
      <ElapsedLabel tracker={tracker} now={now} />
      {tracker.htmlUrl && (
        <a
          href={tracker.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-xs font-medium opacity-80 hover:opacity-100"
        >
          {t("actionsBanner.viewRun")}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      )}
      {tracker.retriable && (
        <button
          type="button"
          onClick={() => onRetry(tracker.id)}
          disabled={retrying}
          aria-label={t("actionsBanner.retry")}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline disabled:opacity-50"
        >
          {retrying ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <RotateCw aria-hidden="true" className="size-3.5" />
          )}
          {t("actionsBanner.retry")}
        </button>
      )}
      {tracker.dismissible && (
        <button
          type="button"
          onClick={() => onDismiss(tracker.id)}
          aria-label={t("actionsBanner.dismiss")}
          className="flex shrink-0 items-center opacity-70 hover:opacity-100"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  )
}

export function ActionsBanner() {
  const { t } = useTranslation()
  const { trackers, runningCount, anyFailed, dismiss, retry, retrying } =
    useActionActivity()
  const collapsed = useSidebarCollapsed()
  const [expanded, setExpanded] = useState(false)

  // A shared 1s clock so running rows advance their elapsed time in step. Only
  // ticks while something is still running (a finished row's elapsed is frozen),
  // so an idle banner does no per-second work.
  const anyRunning = trackers.some(
    (tr) => tr.phase === "running" || tr.phase === "pending",
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [anyRunning])

  // Hold the banner back until the page has painted, so on a browser refresh it
  // fades in AFTER the app content rather than flashing in with (or before) the
  // page. A short post-mount delay lets the initial render settle; the existing
  // AnimatePresence + calloutVariants then plays the fade-in. Gate on
  // document.readyState so a slow initial load waits for it too.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const reveal = () => {
      // One extra tick after load so the reveal lands after the first paint.
      timer = window.setTimeout(() => setReady(true), 150)
    }
    if (document.readyState === "complete") {
      reveal()
    } else {
      window.addEventListener("load", reveal, { once: true })
    }
    return () => {
      window.removeEventListener("load", reveal)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const visible = ready && trackers.length > 0
  const single = trackers.length === 1
  const canExpand = trackers.length > 1

  // Tone: any failure -> error (red); else all done (no running) -> success
  // (green); else working -> warning (orange). Solid fill with the matching
  // -content text/icon color so it reads as a clear status bar, not a wash.
  const tone = anyFailed
    ? "border-error bg-error text-error-content"
    : runningCount === 0
      ? "border-success bg-success text-success-content"
      : "border-warning bg-warning text-warning-content"

  const offsetClass = collapsed ? "left-0 lg:left-16" : "left-0 lg:left-60"

  // The collapsed header leads with the most relevant action (trackers are
  // newest first): when anything failed, the most recent FAILED action leads so
  // the red banner names a real problem; otherwise the most recent action. Its
  // own phase drives the header icon so icon, label, and tone stay coherent.
  const primary =
    (anyFailed && trackers.find((tr) => tr.phase === "failed")) || trackers[0]
  const primaryIconPhase = primary?.phase ?? "running"

  const showList = canExpand && expanded

  return (
    <div
      className={`pointer-events-none fixed right-0 top-0 z-50 ${offsetClass}`}
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            variants={calloutVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            role="status"
            aria-live={anyFailed ? "assertive" : "polite"}
            className={`pointer-events-auto w-full border-b shadow-sm ${tone}`}
          >
            {single ? (
              // One action: show it directly in the bar.
              <div className="px-4 py-2.5">
                <TrackerRow
                  tracker={trackers[0]}
                  onDismiss={dismiss}
                  onRetry={retry}
                  retrying={retrying.has(trackers[0].id)}
                  now={now}
                  compact
                />
              </div>
            ) : (
              // Several actions: the most recent leads, with a total-count
              // badge; expand to see them all.
              <>
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={showList}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
                >
                  <StatusIcon phase={primaryIconPhase} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {primary?.label}
                  </span>
                  <span
                    className="shrink-0 rounded-full bg-black/15 px-2 py-0.5 text-xs font-semibold"
                    aria-label={t("actionsBanner.totalActions", {
                      count: trackers.length,
                    })}
                  >
                    {trackers.length}
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 opacity-70 transition-transform ${
                      showList ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {showList && (
                  <ul className="flex w-full flex-col gap-1 bg-base-100 p-2 text-base-content">
                    {trackers.map((tracker) => (
                      <li key={tracker.id}>
                        <TrackerRow
                          tracker={tracker}
                          onDismiss={dismiss}
                          onRetry={retry}
                          retrying={retrying.has(tracker.id)}
                          now={now}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
