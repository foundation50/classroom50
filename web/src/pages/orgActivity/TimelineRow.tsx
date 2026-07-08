import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ExternalLink,
  FileCog,
  GitCommitHorizontal,
  Loader,
  PlayCircle,
  Zap,
} from "lucide-react"

import { Badge, type BadgeTone, cx } from "@/components/ui"
import type { TimelineItem, TimelineStatus } from "@/lib/activity/timeline"

// Icon + tone per status. Running gets a distinct spinner-ish look; errors are
// error-toned; commits/runs/actions are neutral/info.
function statusVisual(item: TimelineItem): {
  icon: typeof AlertTriangle
  tone: string
} {
  if (item.status === "error")
    return { icon: AlertTriangle, tone: "bg-error/10 text-error" }
  if (item.status === "running")
    return { icon: Loader, tone: "bg-warning/10 text-warning" }
  if (item.source === "commit")
    return {
      icon: item.type === "config" ? FileCog : GitCommitHorizontal,
      tone: "bg-info/10 text-info",
    }
  if (item.source === "run")
    return { icon: PlayCircle, tone: "bg-success/10 text-success" }
  return { icon: Zap, tone: "bg-info/10 text-info" }
}

const STATUS_LABEL_KEY: Record<TimelineStatus, string> = {
  ok: "orgActivity.status.ok",
  error: "orgActivity.status.error",
  running: "orgActivity.status.running",
  info: "orgActivity.status.info",
}

// Badge tone per source: config commits read as info (a durable change to the
// repo), runs as neutral, session errors as error — so a config action is
// visually distinct from a workflow run at a glance.
function badgeTone(item: TimelineItem): BadgeTone {
  if (item.status === "error") return "error"
  if (item.source === "commit") return "info"
  if (item.source === "run") return "success"
  return "neutral"
}

export function TimelineRow({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  const { icon: Icon, tone } = statusVisual(item)

  return (
    <li className="flex items-start gap-3 px-6 py-4">
      <span
        className={cx(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
          tone,
        )}
      >
        <Icon aria-hidden="true" className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-base-content">
          {item.href ? (
            <a
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
            >
              {item.label}
              <ExternalLink aria-hidden="true" className="size-3 opacity-60" />
            </a>
          ) : (
            item.label
          )}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-base-content/60">
          {item.actor && <span>{item.actor}</span>}
          {item.detail && <span className="font-mono">{item.detail}</span>}
          <span>{t(STATUS_LABEL_KEY[item.status])}</span>
        </p>
      </div>

      {/* Right column: type badge + timestamp, right-aligned so every row's
          badge lines up regardless of label length. */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={badgeTone(item)} size="sm">
          {t(`orgActivity.type.${item.type}`)}
        </Badge>
        <time
          className="text-xs text-base-content/50 tabular-nums"
          dateTime={new Date(item.at).toISOString()}
          title={new Date(item.at).toLocaleString()}
        >
          {new Date(item.at).toLocaleString()}
        </time>
      </div>
    </li>
  )
}
