import { createElement } from "react"
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
import type { TFunction } from "i18next"

// Localize the row's detail line. Verbatim kinds (endpoint / sha / event) show
// as-is; the "source" and "status" kinds carry a translatable human prefix
// ("at <loc>", "HTTP <code>") applied here, not in the React-free timeline model.
function formatDetail(item: TimelineItem, t: TFunction): string | undefined {
  if (item.detail === undefined) return undefined
  if (item.detailKind === "source")
    return t("orgActivity.detail.source", { location: item.detail })
  if (item.detailKind === "status")
    return t("orgActivity.detail.status", { code: item.detail })
  return item.detail
}

// One source/status -> tone decision, shared by the icon chip and the Badge, so
// the two never drift (AGENTS.md one-recipe-one-source). Maps to a DaisyUI
// semantic color used both as the Badge tone and, via `${tone}`, the chip's
// bg-<tone>/10 text-<tone> classes.
function itemTone(item: TimelineItem): BadgeTone {
  if (item.status === "error") return "error"
  if (item.status === "running") return "warning"
  if (item.source === "commit") return "info"
  if (item.source === "run") return "success"
  return "info"
}

// Chip background/text derived from the single tone. Static map (not a template
// string) so Tailwind's content scanner keeps these classes.
const CHIP_TONE_CLASS: Record<BadgeTone, string> = {
  error: "bg-error/10 text-error",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  primary: "bg-primary/10 text-primary",
  neutral: "bg-base-300 text-base-content",
}

// Icon per status/source, independent of tone.
function itemIcon(item: TimelineItem): typeof AlertTriangle {
  if (item.status === "error") return AlertTriangle
  if (item.status === "running") return Loader
  if (item.source === "commit")
    return item.type === "config" ? FileCog : GitCommitHorizontal
  if (item.source === "run") return PlayCircle
  return Zap
}

const STATUS_LABEL_KEY: Record<TimelineStatus, string> = {
  ok: "orgActivity.status.ok",
  error: "orgActivity.status.error",
  running: "orgActivity.status.running",
  info: "orgActivity.status.info",
}

export function TimelineRow({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  const tone = itemTone(item)
  const icon = itemIcon(item)
  const detail = formatDetail(item, t)
  const at = new Date(item.at)
  const atLocal = at.toLocaleString()

  return (
    <li className="flex items-start gap-3 px-6 py-4">
      <span
        className={cx(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
          CHIP_TONE_CLASS[tone],
        )}
      >
        {createElement(icon, { "aria-hidden": "true", className: "size-4" })}
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
          {detail && <span className="font-mono">{detail}</span>}
          <span>{t(STATUS_LABEL_KEY[item.status])}</span>
        </p>
      </div>

      {/* Right column: type badge + timestamp, right-aligned so every row's
          badge lines up regardless of label length. */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={tone} size="sm">
          {t(`orgActivity.type.${item.type}`)}
        </Badge>
        <time
          className="text-xs text-base-content/50 tabular-nums"
          dateTime={at.toISOString()}
          title={atLocal}
        >
          {atLocal}
        </time>
      </div>
    </li>
  )
}
