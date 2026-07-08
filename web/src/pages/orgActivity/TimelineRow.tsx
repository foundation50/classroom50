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

import { cx } from "@/components/ui"
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge badge-ghost badge-sm border-base-300">
            {t(`orgActivity.type.${item.type}`)}
          </span>
          <p className="text-sm font-medium break-words text-base-content">
            {item.href ? (
              <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                {item.label}
                <ExternalLink
                  aria-hidden="true"
                  className="size-3 opacity-60"
                />
              </a>
            ) : (
              item.label
            )}
          </p>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-base-content/60">
          {item.actor && <span>{item.actor}</span>}
          {item.detail && <span className="font-mono">{item.detail}</span>}
          <span>{t(STATUS_LABEL_KEY[item.status])}</span>
        </p>
      </div>
      <time
        className="mt-0.5 shrink-0 text-xs text-base-content/50 tabular-nums"
        dateTime={new Date(item.at).toISOString()}
        title={new Date(item.at).toLocaleString()}
      >
        {new Date(item.at).toLocaleString()}
      </time>
    </li>
  )
}
