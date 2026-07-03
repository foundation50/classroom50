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

// Compact elapsed duration ("8s", "1m 12s", "3m", "1h 5m"). "" for a
// non-positive span.
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Elapsed time: live-ticking while running (via the banner's shared 1s `now`),
// frozen once finished.
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

// App-wide banner fixed to the top, showing GitHub Actions activity for the
// current org as per-operation trackers. One tracker shows inline; several
// collapse to a header (latest action + count) that expands to a per-row list.
// Mounts above the router (so it survives route changes) — hence NO TanStack
// <Link>; run links are plain <a href> to github.com.

// Phase icon. `tinted` applies the phase's semantic color (per-row list on a
// neutral surface); without it the icon inherits the solid-tone header color.
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

// Per-phase tone for an expanded row, so each row is distinguishable inside the
// neutral list even when the header is red.
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
  // compact = inline in the collapsed single-tracker bar (inherits header tone);
  // otherwise the row carries its own per-phase tone.
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
          className="flex shrink-0 cursor-pointer items-center gap-1 text-xs font-medium opacity-80 hover:opacity-100"
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
          className="flex shrink-0 cursor-pointer items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
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
          className="flex shrink-0 cursor-pointer items-center opacity-70 hover:opacity-100"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  )
}

// The banner's inner content (one row, or the expandable header + list).
// Extracted so it renders both in the hidden measuring probe and the visible bar.
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
  // Failed actions the header isn't leading with — shown as a "needs attention"
  // badge, independent of the bar's tone.
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
  // Several actions: latest leads with a count badge; expand for the full list.
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={showList}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left"
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
  const { trackers, anyFailed, dismiss, retry, retrying } = useActionActivity()
  const [expanded, setExpanded] = useState(false)

  // Shared 1s clock so running rows tick in step. Runs only while something is
  // running, so an idle banner does no per-second work.
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

  // Hold the banner until after the page paints so it slides in after the app
  // content on a refresh, not with/before it. Gate on document.readyState so a
  // slow load waits too.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const reveal = () => {
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

  // Header leads with the LATEST action (trackers are newest-first), so a new
  // action after a failure takes over the title; its own phase drives the icon.
  const primary = trackers[0]
  const primaryPhase = primary?.phase ?? "running"
  const failedCount = trackers.filter((tr) => tr.phase === "failed").length

  // Tone follows the LATEST action's phase (green/orange/red) — an older
  // failure does NOT repaint the whole bar; it surfaces as the attention badge
  // below instead. Solid fill with the matching -content color.
  const tone =
    primaryPhase === "failed"
      ? "border-error bg-error text-error-content"
      : primaryPhase === "success"
        ? "border-success bg-success text-success-content"
        : "border-warning bg-warning text-warning-content"

  // Failed actions NOT leading the header (the badge count). When the latest
  // action is itself the failure, the bar is already red, so exclude it.
  const attentionCount =
    primaryPhase === "failed" ? failedCount - 1 : failedCount

  const showList = canExpand && expanded

  // Reserve body padding equal to the banner height so it PUSHES the app down
  // instead of overlaying page content. The banner is a full-width fixed bar
  // above the router (out of normal flow), so we mirror its position onto
  // document.body's padding-top, shifting the whole app down as one.
  //
  // Enter/exit slide `y` from -height to 0 and back; padding = height + y tracks
  // the banner's bottom edge frame-for-frame, so the app slides with it. Height
  // is measured from the inner content (unaffected by the slide) via a
  // ResizeObserver so expanding the list keeps the reservation in sync.
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

  // `y` (Framer-animated on enter/exit) drives body padding = height + y, so the
  // app slides with the banner. onExitComplete below hard-clears the gap so a
  // reduced-motion or interrupted exit can't strand a permanent top gap.
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
      {/* Hidden probe: measures the banner height before the animated bar
          mounts so the slide-in can start from the true offset. Laid out (not
          display:none) but invisible and inert. */}
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
