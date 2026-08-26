// Presentational scaffolding shared by the bulk fan-out modals and action bars
// (org-members and roster). Each caller owns its own action orchestration and
// result mappers; only the generic "run phase + progress + labeled sections of
// {label, detail} rows in a modal" shell is shared, so a change to the
// presentation lands in one place rather than drifting across the copies.

import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { Spinner } from "@/components/Spinner"

// The lifecycle of a bulk run's modal: idle (closed) -> working (progress) ->
// complete/error (results).
export type BulkPhase = "idle" | "working" | "complete" | "error"

export type BulkProgress = { processed: number; total: number; message: string }

// A completed run, normalized so the results modal renders one shape regardless
// of which action produced it. `sections` are labeled groups of per-row lines
// (added / skipped / failed / warnings).
export type BulkResultView = {
  headline: string
  sections: {
    title: string
    rows: { key: string; label: string; detail?: string }[]
  }[]
}

export const BulkResultSection = ({
  title,
  rows,
}: {
  title: string
  rows: { key: string; label: string; detail?: string }[]
}) => (
  <div>
    <h4 className="mb-2 font-semibold">{title}</h4>
    <div className="max-h-48 overflow-auto rounded-box border border-base-300">
      <table className="table table-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <code>{row.label}</code>
              </td>
              <td className="opacity-70">{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
)

// The canonical bulk-modal footer: a finished run (complete/error) dismisses
// with primary Done; before that, ghost Cancel plus the idle-only primary
// Apply. CloseSubmissionModal keeps its own footer — its finish-closing branch
// is intentional divergence, not drift.
export const BulkPhaseFooter = ({
  phase,
  busy,
  showApply,
  applyDisabled = false,
  applyLabel,
  onApply,
  onClose,
}: {
  phase: BulkPhase
  busy: boolean
  // Render the Apply action while idle; false when there is nothing to run on.
  showApply: boolean
  applyDisabled?: boolean
  applyLabel: string
  onApply: () => void
  onClose: () => void
}) => {
  const { t } = useTranslation()
  if (phase === "complete" || phase === "error") {
    return (
      <Button variant="primary" onClick={onClose}>
        {t("common.done")}
      </Button>
    )
  }
  return (
    <>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        {t("common.cancel")}
      </Button>
      {phase === "idle" && showApply && (
        <Button variant="primary" disabled={applyDisabled} onClick={onApply}>
          {applyLabel}
        </Button>
      )}
    </>
  )
}

// The working-phase block: spinner, percent bar, caption. With
// `indeterminateUntilFirst`, the bar omits `value` until the first item lands
// so a slow first write animates instead of sitting at 0%.
export const BulkProgressBlock = ({
  workingLabel,
  caption,
  progress,
  indeterminateUntilFirst = false,
}: {
  workingLabel: string
  caption: React.ReactNode
  progress: BulkProgress
  indeterminateUntilFirst?: boolean
}) => {
  const pct =
    progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0
  return (
    <div className="mt-6 flex flex-col items-center gap-3 py-6">
      <Spinner label={workingLabel} />
      <progress
        className="progress progress-primary w-full"
        {...(indeterminateUntilFirst && progress.processed === 0
          ? {}
          : { value: pct })}
        max={100}
      />
      <p className="text-sm text-base-content/70">{caption}</p>
    </div>
  )
}
