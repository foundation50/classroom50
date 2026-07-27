import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/ui"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

// One concise, high-level category the import will apply, derived from the
// preflight buckets. Kept deliberately small (add / update / skip) so the
// summary reads at a glance; the expandable table carries the per-row detail.
export type SummaryCategory = {
  key: "add" | "update" | "skip"
  count: number
  // Tailwind/DaisyUI classes for the count pill.
  pillClass: string
}

// Collapse the five preflight buckets into the three teacher-facing categories:
//  - add:    a membership will be created/activated (invite + enroll)
//  - update: an existing member's details or role change (metadata + role_change)
//  - skip:   already correct, nothing to do (no_action)
export function summarizePreflight(preflight: PreflightResult): {
  categories: SummaryCategory[]
  addCount: number
  updateCount: number
  skipCount: number
} {
  const addCount = preflight.needsInvite.length + preflight.enroll.length
  const updateCount =
    preflight.metadataUpdate.length + preflight.roleChanges.length
  const skipCount = preflight.noAction.length
  const categories: SummaryCategory[] = [
    { key: "add", count: addCount, pillClass: "badge-success" },
    { key: "update", count: updateCount, pillClass: "badge-warning" },
    { key: "skip", count: skipCount, pillClass: "badge-ghost" },
  ]
  return { categories, addCount, updateCount, skipCount }
}

// A concise summary of what the import will do, with a "view details" toggle.
// Replaces the five-tile grid: only non-zero categories render, as inline
// count pills, so a teacher sees "3 to add, 1 to update" at a glance rather
// than a wall of tiles (most of them zero).
export const PreflightSummary = ({
  preflight,
  detailsOpen,
  onToggleDetails,
  canToggle = true,
}: {
  preflight: PreflightResult
  detailsOpen: boolean
  onToggleDetails: () => void
  // Whether the details toggle is meaningful. False when the table is force-open
  // (e.g. a pending confirmation, or a no-changes preview where the full CSV is
  // always shown), so we hide a toggle that couldn't collapse it.
  canToggle?: boolean
}) => {
  const { t } = useTranslation()
  const { categories } = summarizePreflight(preflight)
  const active = categories.filter((c) => c.count > 0)

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-box border border-base-300 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {active.length === 0 ? (
          <span className="opacity-70">{t("students.summaryNoChanges")}</span>
        ) : (
          active.map((c) => (
            <span key={c.key} className="flex items-center gap-1.5">
              <Badge className={c.pillClass}>{c.count}</Badge>
              <span>{t(`students.summary_${c.key}`, { count: c.count })}</span>
            </span>
          ))
        )}
      </div>
      {canToggle ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={detailsOpen}
          onClick={onToggleDetails}
        >
          {detailsOpen
            ? t("students.summaryHideDetails")
            : t("students.summaryViewDetails")}
        </Button>
      ) : null}
    </div>
  )
}
