// Presentational scaffolding shared by the bulk fan-out modals and action bars
// (org-members and roster). Each caller owns its own action orchestration and
// result mappers; only the generic "run phase + progress + labeled sections of
// {label, detail} rows in a modal" shell is shared, so a change to the
// presentation lands in one place rather than drifting across the copies.

import { useTranslation } from "react-i18next"

import { Button, Spinner } from "@/components/ui"

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

// One copy of the ratio math: the <progress> fill and any textual percent
// both derive from here.
export const bulkProgressPct = (
  progress: Pick<BulkProgress, "processed" | "total">,
) =>
  progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0

// Shared <progress> props. With `indeterminateUntilFirst`, `value` is omitted
// until the first item lands so a slow first write animates as an
// indeterminate track instead of sitting at 0%.
export const bulkProgressBarProps = (
  progress: Pick<BulkProgress, "processed" | "total">,
  indeterminateUntilFirst = false,
) => ({
  className: "progress progress-primary w-full",
  ...(indeterminateUntilFirst && progress.processed === 0
    ? {}
    : { value: bulkProgressPct(progress) }),
  max: 100,
})

// The working-phase block: spinner, percent bar, caption.
export const BulkProgressBlock = ({
  workingLabel,
  caption,
  progress,
  indeterminateUntilFirst = false,
}: {
  workingLabel: string
  caption: React.ReactNode
  progress: Pick<BulkProgress, "processed" | "total">
  indeterminateUntilFirst?: boolean
}) => (
  <div className="mt-6 flex flex-col items-center gap-3 py-6">
    <Spinner label={workingLabel} />
    <progress {...bulkProgressBarProps(progress, indeterminateUntilFirst)} />
    <p className="break-all text-center text-sm text-base-content/70">
      {caption}
    </p>
  </div>
)

// The action bars' working layout: message heading, bar, processed/total on
// the left and percent on the right, then any trailing content (the
// keep-tab-open alert).
export const BulkProgressRow = ({
  progress,
  processedCaption,
  percentCaption,
  children,
}: {
  progress: BulkProgress
  processedCaption: React.ReactNode
  percentCaption: React.ReactNode
  children?: React.ReactNode
}) => (
  <div className="mt-6">
    <p className="mb-2 font-medium">{progress.message}</p>
    <progress {...bulkProgressBarProps(progress)} />
    <div className="mt-2 flex justify-between text-sm opacity-70">
      <span>{processedCaption}</span>
      <span>{percentCaption}</span>
    </div>
    {children}
  </div>
)

// The submissions modals' running block: spinner-prefixed status line above
// the bar.
export const BulkProgressInline = ({
  label,
  progress,
}: {
  label: React.ReactNode
  progress: Pick<BulkProgress, "processed" | "total">
}) => (
  <div className="mt-4 space-y-3">
    <p className="flex items-center gap-2 text-sm text-base-content/70">
      <Spinner size="xs" />
      {label}
    </p>
    <progress {...bulkProgressBarProps(progress)} />
  </div>
)
