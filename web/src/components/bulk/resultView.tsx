// Presentational scaffolding shared by the bulk-action bars (org-members and
// roster). Each bar owns its own action orchestration and result mappers; only
// this generic "run phase + labeled sections of {label, detail} rows in a
// modal" shell is shared, so a change to result presentation lands in one place
// rather than drifting across the copies.

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
