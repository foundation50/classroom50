import { useTranslation } from "react-i18next"

import { cx } from "@/components/ui"
import type { TimelineSource, TimelineType } from "@/lib/activity/timeline"

// Source + type filter chips for the org Activity timeline. Empty selection =
// show all. Multi-select within each dimension; the two dimensions AND together
// (handled by mergeTimeline).
export type ActivityFilterState = {
  sources: Set<TimelineSource>
  types: Set<TimelineType>
}

const SOURCE_ORDER: TimelineSource[] = ["commit", "run", "session"]
const TYPE_ORDER: TimelineType[] = [
  "assignment",
  "classroom",
  "student",
  "scores",
  "config",
  "run",
  "error",
  "action",
]

function Chip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "badge cursor-pointer gap-1 border transition-colors",
        active
          ? "badge-primary"
          : "badge-ghost border-base-300 hover:border-primary/40",
      )}
    >
      {label}
    </button>
  )
}

export function ActivityFilters({
  state,
  onChange,
}: {
  state: ActivityFilterState
  onChange: (next: ActivityFilterState) => void
}) {
  const { t } = useTranslation()

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-base-content/50">
          {t("orgActivity.filters.source")}
        </span>
        {SOURCE_ORDER.map((s) => (
          <Chip
            key={s}
            active={state.sources.has(s)}
            label={t(`orgActivity.source.${s}`)}
            onClick={() =>
              onChange({ ...state, sources: toggle(state.sources, s) })
            }
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-base-content/50">
          {t("orgActivity.filters.type")}
        </span>
        {TYPE_ORDER.map((ty) => (
          <Chip
            key={ty}
            active={state.types.has(ty)}
            label={t(`orgActivity.type.${ty}`)}
            onClick={() =>
              onChange({ ...state, types: toggle(state.types, ty) })
            }
          />
        ))}
      </div>
    </div>
  )
}
