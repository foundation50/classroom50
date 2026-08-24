import { useCallback, useEffect, useMemo, useState } from "react"

import {
  Alert,
  Badge,
  Button,
  Card,
  Select,
  Textarea,
  cx,
  Heading,
} from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import {
  CONFORMANCE_LABEL,
  CONFORMANCE_TONE,
  type Criterion,
  type EvidenceKind,
  type ManualVerdict,
} from "@/util/a11y/vpatModel"
import type { Guidance } from "@/util/a11y/assessmentGuidance"

// Dev-only interactive WCAG assessment tool (route: /assess). It pulls in the
// full VPAT report: the manually-assessed criteria are editable (record, then
// override or reopen a saved verdict), and the automated/contrast/architectural
// rows are shown read-only for context. Saving posts to the dev endpoint
// (assessmentApiPlugin in vite.config.ts), which writes vpatVerdicts.json (the
// VPAT overlay). Never shipped: the route redirects away unless
// import.meta.env.DEV and the endpoint is serve-only.

// The two save-body shapes the /_assess/save endpoint accepts: record/update a
// verdict, or clear (reopen) one. Documents the client contract; the endpoint
// re-validates.
type SavePayload =
  | { id: string; status: ManualVerdict["status"]; remark: string }
  | { id: string; clear: true }

type AssessData = {
  criteria: Criterion[]
  guidance: Guidance[]
  verdicts: Record<string, ManualVerdict>
}

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  contrast: "Automated (contrast)",
  automated: "Automated",
  manual: "Manual",
  architectural: "Architectural (N/A)",
}

// A criterion is manually-owned when it is still notEvaluated with no evidence,
// or already carries a recorded manual verdict.
const isManual = (c: Criterion, verdicts: Record<string, ManualVerdict>) =>
  (c.status === "notEvaluated" && c.evidence === undefined) ||
  verdicts[c.id] !== undefined

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
    [data?.guidance],
  )

  const verdicts = useMemo(() => data?.verdicts ?? {}, [data?.verdicts])
  const criteria = useMemo(() => data?.criteria ?? [], [data?.criteria])

  const manual = useMemo(
    () => criteria.filter((c) => isManual(c, verdicts)),
    [criteria, verdicts],
  )
  const outstanding = useMemo(
    () => manual.filter((c) => verdicts[c.id] === undefined),
    [manual, verdicts],
  )
  const recorded = useMemo(
    () => manual.filter((c) => verdicts[c.id] !== undefined),
    [manual, verdicts],
  )
  // Everything else is machine-established (automated/contrast) or N/A: context.
  const readOnly = useMemo(
    () => criteria.filter((c) => !isManual(c, verdicts)),
    [criteria, verdicts],
  )

  const save = useCallback(async (body: SavePayload) => {
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
        <Heading as="h1" variant="title-medium">
          Assessment mode — WCAG 2.2 AA
        </Heading>
        <p className="text-base-content/70">
          Record a verdict for each manually-assessed success criterion. Saving
          writes <code>vpatVerdicts.json</code>, which feeds the VPAT report.
          This tool runs only in local development.
        </p>
        <p className="text-sm font-medium" aria-live="polite">
          {recorded.length} of {manual.length} manual criteria assessed ·{" "}
          {outstanding.length} remaining · {readOnly.length} automated / N/A
        </p>
      </header>

      {error && <Alert tone="error">{error}</Alert>}

      {outstanding.length === 0 && (
        <Alert tone="success">
          Every manually-assessed criterion has a recorded verdict.
        </Alert>
      )}

      {outstanding.length > 0 && (
        <section className="space-y-4">
          <Heading as="h2">Outstanding</Heading>
          <ol className="space-y-4">
            {outstanding.map((c) => (
              <EditableCriterionCard
                key={c.id}
                criterion={c}
                guidance={guidanceById.get(c.id)}
                verdict={undefined}
                onSave={save}
              />
            ))}
          </ol>
        </section>
      )}

      {recorded.length > 0 && (
        <section className="space-y-4">
          <Heading as="h2">Recorded verdicts</Heading>
          <ol className="space-y-4">
            {recorded.map((c) => (
              <EditableCriterionCard
                // Re-key on the recorded verdict so the card re-initializes its
                // prefilled fields after an override lands.
                key={`${c.id}:${verdicts[c.id].status}:${verdicts[c.id].remark}`}
                criterion={c}
                guidance={guidanceById.get(c.id)}
                verdict={verdicts[c.id]}
                onSave={save}
                recorded
              />
            ))}
          </ol>
        </section>
      )}

      {readOnly.length > 0 && (
        <section className="space-y-4">
          <Heading as="h2">Automated &amp; not-applicable (read-only)</Heading>
          <p className="text-sm text-base-content/70">
            Established by tooling or the client-side-only architecture. Shown
            for the full VPAT picture; not manually editable.
          </p>
          <ol className="space-y-3">
            {readOnly.map((c) => (
              <ReadOnlyCriterionCard key={c.id} criterion={c} />
            ))}
          </ol>
        </section>
      )}
    </main>
  )
}

function EditableCriterionCard({
  criterion,
  guidance,
  verdict,
  onSave,
  recorded = false,
}: {
  criterion: Criterion
  guidance: Guidance | undefined
  verdict: ManualVerdict | undefined
  onSave: (body: SavePayload) => Promise<void>
  recorded?: boolean
}) {
  const [status, setStatus] = useState<ManualVerdict["status"]>(
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
        <Heading as="h3">
          {criterion.id} {criterion.name}
        </Heading>
        <Badge tone="neutral" soft>
          {criterion.level}
        </Badge>
        {recorded && verdict && (
          <Badge tone={CONFORMANCE_TONE[verdict.status]}>
            {CONFORMANCE_LABEL[verdict.status]}
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
            onChange={(e) =>
              setStatus(e.target.value as ManualVerdict["status"])
            }
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

function ReadOnlyCriterionCard({ criterion }: { criterion: Criterion }) {
  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Heading as="h3">
          {criterion.id} {criterion.name}
        </Heading>
        <Badge tone="neutral" soft>
          {criterion.level}
        </Badge>
        <Badge tone={CONFORMANCE_TONE[criterion.status]}>
          {CONFORMANCE_LABEL[criterion.status]}
        </Badge>
        {criterion.evidence && (
          <Badge tone="neutral" soft>
            {EVIDENCE_LABEL[criterion.evidence]}
          </Badge>
        )}
      </div>
      <p className="mt-2 text-sm text-base-content/70">{criterion.remark}</p>
    </Card>
  )
}
