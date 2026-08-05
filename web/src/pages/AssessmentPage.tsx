import { useCallback, useEffect, useMemo, useState } from "react"

import {
  Alert,
  Badge,
  Button,
  Card,
  Select,
  Textarea,
  cx,
} from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import type { Criterion } from "@/util/vpatModel"
import type { Guidance } from "@/util/assessmentGuidance"

// Dev-only interactive WCAG assessment tool (route: /_assess). Click through the
// still-outstanding success criteria, record a verdict + remark, and the dev
// endpoint (assessmentApiPlugin in vite.config.ts) writes it back to
// vpatVerdicts.json (the VPAT overlay). Never shipped: the route
// redirects away unless import.meta.env.DEV and the endpoint is serve-only.

type ManualStatus = "supports" | "partially" | "doesNotSupport"

type Verdict = { status: ManualStatus; evidence: "manual"; remark: string }

type AssessData = {
  criteria: Criterion[]
  guidance: Guidance[]
  verdicts: Record<string, Verdict>
}

const STATUS_TONE: Record<ManualStatus, BadgeTone> = {
  supports: "success",
  partially: "warning",
  doesNotSupport: "error",
}

const STATUS_LABEL: Record<ManualStatus, string> = {
  supports: "Supports",
  partially: "Partially Supports",
  doesNotSupport: "Does Not Support",
}

export default function AssessmentPage() {
  useDocumentTitle("Assessment mode — WCAG 2.2 AA")
  const [data, setData] = useState<AssessData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch("/_assess/data")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<AssessData>
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "load failed"))
  }, [])

  useEffect(load, [load])

  const guidanceById = useMemo(
    () => new Map((data?.guidance ?? []).map((g) => [g.id, g])),
    [data],
  )

  // Outstanding = notEvaluated with no evidence (the manual-owned rows). The
  // endpoint returns the merged criteria, so a recorded verdict already shows
  // its status here.
  const outstanding = useMemo(
    () =>
      (data?.criteria ?? []).filter(
        (c) => c.status === "notEvaluated" && c.evidence === undefined,
      ),
    [data],
  )
  const assessed = useMemo(
    () =>
      (data?.criteria ?? []).filter(
        (c) => data?.verdicts && data.verdicts[c.id] !== undefined,
      ),
    [data],
  )

  const total = outstanding.length + assessed.length

  const save = useCallback(async (body: Record<string, unknown>) => {
    setError(null)
    try {
      const res = await fetch("/_assess/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const next = (await res.json()) as AssessData & { error?: string }
      if (next.error) {
        setError(next.error)
        return
      }
      setData(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed")
    }
  }, [])

  if (error && !data) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Alert tone="error">
          Could not reach the assessment endpoint: {error}
        </Alert>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p className="text-base-content/70">Loading assessment data…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Assessment mode — WCAG 2.2 AA</h1>
        <p className="text-base-content/70">
          Record a verdict for each manually-assessed success criterion. Saving
          writes <code>vpatVerdicts.json</code>, which feeds the VPAT report.
          This tool runs only in local development.
        </p>
        <p className="text-sm font-medium" aria-live="polite">
          {assessed.length} of {total} assessed · {outstanding.length} remaining
        </p>
      </header>

      {error && <Alert tone="error">{error}</Alert>}

      {outstanding.length === 0 && (
        <Alert tone="success">
          Every manually-assessed criterion has a recorded verdict.
        </Alert>
      )}

      <ol className="space-y-4">
        {outstanding.map((c) => (
          <CriterionCard
            key={c.id}
            criterion={c}
            guidance={guidanceById.get(c.id)}
            verdict={data.verdicts[c.id]}
            onSave={save}
          />
        ))}
      </ol>

      {assessed.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Recorded verdicts</h2>
          <ol className="space-y-4">
            {assessed.map((c) => (
              <CriterionCard
                key={c.id}
                criterion={c}
                guidance={guidanceById.get(c.id)}
                verdict={data.verdicts[c.id]}
                onSave={save}
                recorded
              />
            ))}
          </ol>
        </section>
      )}
    </main>
  )
}

function CriterionCard({
  criterion,
  guidance,
  verdict,
  onSave,
  recorded = false,
}: {
  criterion: Criterion
  guidance: Guidance | undefined
  verdict: Verdict | undefined
  onSave: (body: Record<string, unknown>) => Promise<void>
  recorded?: boolean
}) {
  const [status, setStatus] = useState<ManualStatus>(
    verdict?.status ?? "supports",
  )
  const [remark, setRemark] = useState(verdict?.remark ?? "")
  const [busy, setBusy] = useState(false)

  const statusId = `status-${criterion.id}`
  const remarkId = `remark-${criterion.id}`

  const submit = async () => {
    setBusy(true)
    await onSave({ id: criterion.id, status, remark })
    setBusy(false)
  }

  const reopen = async () => {
    setBusy(true)
    await onSave({ id: criterion.id, clear: true })
    setBusy(false)
  }

  return (
    <Card as="li" className={cx("p-4", recorded && "opacity-90")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">
          {criterion.id} {criterion.name}
        </h3>
        <Badge tone="neutral" soft>
          {criterion.level}
        </Badge>
        {recorded && verdict && (
          <Badge tone={STATUS_TONE[verdict.status]}>
            {STATUS_LABEL[verdict.status]}
          </Badge>
        )}
      </div>

      {guidance && (
        <ul className="mt-3 space-y-1 text-sm text-base-content/80">
          {guidance.bullets.map((b) => (
            <li key={b.label}>
              <span className="font-medium">{b.label}:</span> {b.text}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-3">
        <div>
          <label htmlFor={statusId} className="mb-1 block text-sm font-medium">
            Verdict
          </label>
          <Select
            id={statusId}
            selectSize="sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as ManualStatus)}
          >
            <option value="supports">Supports</option>
            <option value="partially">Partially Supports</option>
            <option value="doesNotSupport">Does Not Support</option>
          </Select>
        </div>
        <div>
          <label htmlFor={remarkId} className="mb-1 block text-sm font-medium">
            Remark
          </label>
          <Textarea
            id={remarkId}
            rows={3}
            value={remark}
            placeholder="What you tested + the outcome, e.g. 2026-08-05 — VoiceOver/Safari: …"
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || remark.trim() === ""}
          >
            {recorded ? "Update" : "Save verdict"}
          </Button>
          {recorded && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void reopen()}
              disabled={busy}
            >
              Reopen
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
