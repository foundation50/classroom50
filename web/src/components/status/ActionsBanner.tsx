import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useMotionValueEvent,
} from "motion/react"
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
import { DURATION, EASE_OUT } from "@/lib/motion"

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

// The banner's inner content (one row, or the expandable multi-row header +
// list). Extracted so it can render both in a hidden measuring probe — to learn
// the height before the animated bar mounts, so the slide-in starts from the
// real offset — and in the visible animated bar itself.
const BannerBody = ({
  trackers,
  primary,
  primaryPhase,
  attentionCount,
  single,
  showList,
  setExpanded,
  dismiss,
  retry,
  retrying,
  now,
}: {
  trackers: Tracker[]
  primary: Tracker | undefined
  primaryPhase: Tracker["phase"]
  // Failed actions the header isn't itself leading with — surfaced as a
  // "needs attention" error badge, independent of the bar's own tone.
  attentionCount: number
  single: boolean
  showList: boolean
  setExpanded: (fn: (v: boolean) => boolean) => void
  dismiss: (id: string) => void
  retry: (id: string) => void
  retrying: ReadonlySet<string>
  now: number
}) => {
  const { t } = useTranslation()
  if (single) {
    // One action: show it directly in the bar.
    return (
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
    )
  }
  // Several actions: the most recent leads, with a total-count badge; expand to
  // see them all.
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={showList}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <StatusIcon phase={primaryPhase} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {primary?.label}
        </span>
        {attentionCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-error px-2 py-0.5 text-xs font-semibold text-error-content"
            aria-label={t("actionsBanner.failedActions", {
              count: attentionCount,
            })}
          >
            <AlertTriangle aria-hidden="true" className="size-3.5" />
            {attentionCount}
          </span>
        )}
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
  )
}

export function ActionsBanner() {
  const { trackers, anyFailed, dismiss, retry, retrying } =
    useActionActivity()
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
  // slides in AFTER the app content rather than flashing in with (or before) the
  // page. A short post-mount delay lets the initial render settle; the
  // AnimatePresence slide-in below then plays. Gate on document.readyState so a
  // slow initial load waits for it too.
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

  // The collapsed header always leads with the LATEST action (trackers are
  // newest first), so a new action taken after a failure takes over the title —
  // the teacher sees what they just did, not the stale failure. The header icon
  // reflects the latest action's own phase so icon and label stay coherent.
  const primary = trackers[0]
  const primaryPhase = primary?.phase ?? "running"
  const failedCount = trackers.filter((tr) => tr.phase === "failed").length

  // Tone follows the LATEST action's own phase, so the bar honestly reflects
  // what just happened — green when it succeeded, orange while it's working,
  // red only when the latest action itself failed. A failure in an OLDER action
  // is NOT allowed to repaint the whole bar red (that would mislabel a
  // succeeding action); it surfaces instead as the "needs attention" error
  // badge below, which is the single cross-state failure signal. Solid fill
  // with the matching -content text/icon color so it reads as a clear status
  // bar, not a wash.
  const tone =
    primaryPhase === "failed"
      ? "border-error bg-error text-error-content"
      : primaryPhase === "success"
        ? "border-success bg-success text-success-content"
        : "border-warning bg-warning text-warning-content"

  // Other actions that failed but aren't the one leading the header — the count
  // the "needs attention" badge shows. When the latest action IS the failure,
  // the bar is already red and the badge would be redundant, so exclude it.
  const attentionCount =
    primaryPhase === "failed" ? failedCount - 1 : failedCount

  const showList = canExpand && expanded

  // Reserve vertical space equal to the banner's height so it PUSHES the app
  // down instead of overlaying the content beneath it (a fixed bar would sit on
  // top of a page heading). The banner is a full-width bar fixed at the top,
  // mounted above the router so it survives route changes; that takes it out of
  // normal flow, so we mirror its position onto document.body's padding-top,
  // which shifts the whole app (sidebar and content) down as one.
  //
  // Enter/exit slide vertically: `y` runs from -height (fully above the
  // viewport) to 0 on enter, and back on exit. The reserved padding is derived
  // as height + y, so the app top tracks the banner's bottom edge frame-for-
  // frame — the banner slides up and the app slides up to fill the gap together,
  // with no snap when it finally unmounts. Height is measured from the inner
  // content (unaffected by the slide) via a ResizeObserver so expanding the
  // list keeps the reserved space in sync.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [bannerHeight, setBannerHeight] = useState(0)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => setBannerHeight(el.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible])

  // `y` is the banner's vertical offset, animated by Framer on enter/exit.
  // Reserved body padding = height + y, so it tracks the slide (y changes every
  // frame) and a height change (measure / list expand). The exit animation
  // drives y to -height, sliding the app up in lockstep; AnimatePresence's
  // onExitComplete below then hard-clears the gap so a reduced-motion or
  // interrupted exit (where y may never reach exactly -height) can't strand a
  // permanent top gap across the whole app.
  const y = useMotionValue(-bannerHeight)
  useMotionValueEvent(y, "change", (value) => {
    const px = Math.max(0, bannerHeight + value)
    document.body.style.paddingTop = px > 0 ? `${px}px` : ""
  })
  useEffect(() => {
    if (!visible) return
    const px = Math.max(0, bannerHeight + y.get())
    document.body.style.paddingTop = px > 0 ? `${px}px` : ""
    return () => {
      document.body.style.paddingTop = ""
    }
  }, [visible, bannerHeight, y])
  const clearReservedGap = () => {
    document.body.style.paddingTop = ""
  }

  const body = (
    <BannerBody
      trackers={trackers}
      primary={primary}
      primaryPhase={primaryPhase}
      attentionCount={attentionCount}
      single={single}
      showList={showList}
      setExpanded={setExpanded}
      dismiss={dismiss}
      retry={retry}
      retrying={retrying}
      now={now}
    />
  )

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50">
      {/* Hidden probe: mounted whenever the banner is visible so its height is
          known BEFORE the animated bar mounts, letting the slide-in start from
          the true offset (a slide can't animate from an as-yet-unmeasured
          height). Laid out (not display:none) so it has a real height, but
          invisible and inert. */}
      {visible && (
        <div
          ref={contentRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-0 top-0 w-full border-b"
        >
          {body}
        </div>
      )}
      <AnimatePresence onExitComplete={clearReservedGap}>
        {visible && bannerHeight > 0 && (
          <motion.div
            style={{ y }}
            initial={{ y: -bannerHeight }}
            animate={{
              y: 0,
              transition: { duration: DURATION.slow, ease: EASE_OUT },
            }}
            exit={{
              y: -bannerHeight,
              transition: { duration: DURATION.base, ease: EASE_OUT },
            }}
            role="status"
            aria-live={anyFailed ? "assertive" : "polite"}
            className={`pointer-events-auto w-full border-b shadow-sm ${tone}`}
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
