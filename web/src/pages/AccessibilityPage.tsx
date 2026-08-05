import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Info } from "lucide-react"

import { Alert, Badge, Button, Card, Modal } from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Public /accessibility page: renders the build-emitted contrast-audit.json (the
// source of truth) as a themed table with live color previews. No auth, so an
// ADA/VPAT reviewer can open it; the .md download carries both themes.

type ContrastStatus = "pass" | "fail" | "exempt"

type Row = {
  id: string
  label: string
  size: "body" | "large"
  kind: "text" | "nonText"
  ratio: number
  floor: number
  margin: number
  status: ContrastStatus
  withinMargin: boolean
  fgHex: string
  bgHex: string
}

type AuditTheme = { theme: string; label: string; rows: Row[] }

type Audit = {
  schema: string
  standard: string
  generated: string
  thresholds: { body: number; large: number; nonText: number }
  margins: { body: number; large: number; nonText: number }
  summary: {
    total: number
    failures: number
    marginMisses: number
    allPass: boolean
  }
  themes: AuditTheme[]
}

const STATUS_TONE: Record<ContrastStatus, BadgeTone> = {
  pass: "success",
  fail: "error",
  exempt: "neutral",
}

type VpatConformance =
  "supports" | "partially" | "doesNotSupport" | "notApplicable" | "notEvaluated"

type VpatCriterion = {
  id: string
  name: string
  level: "A" | "AA" | "AAA"
  principle: string
  status: VpatConformance
  remark: string
}

type Vpat = {
  schema: string
  product: string
  generated: string
  summary: {
    total: number
    byStatus: Record<VpatConformance, number>
  }
  criteria: VpatCriterion[]
}

const VPAT_TONE: Record<VpatConformance, BadgeTone> = {
  supports: "success",
  partially: "warning",
  doesNotSupport: "error",
  notApplicable: "neutral",
  notEvaluated: "neutral",
}

const PRINCIPLE_ORDER = [
  "Perceivable",
  "Operable",
  "Understandable",
  "Robust",
] as const

// A live preview of the pair — the actual foreground text on the actual
// surface. Rendered as a button that opens the detail modal.
function ColorPreviewButton({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const { t } = useTranslation()
  const isText = row.kind === "text"
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("accessibility.preview.open")}
      aria-label={t("accessibility.preview.openFor", { pair: row.id })}
      className="flex h-9 w-14 cursor-pointer items-center justify-center rounded border border-base-300 text-sm font-semibold transition hover:ring-2 hover:ring-primary/40"
      style={{ backgroundColor: row.bgHex, color: row.fgHex }}
    >
      <span aria-hidden="true">{isText ? "Aa" : "▭"}</span>
    </button>
  )
}

// One reference chip: a small swatch + role label + hex. Reference only — the
// combined sample above is what actually shows the contrast.
function ColorRef({ hex, role }: { hex: string; role: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="size-8 shrink-0 rounded border border-base-300"
        style={{ backgroundColor: hex }}
        aria-hidden="true"
      />
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-base-content/60">
          {role}
        </span>
        <span className="font-mono text-sm">{hex}</span>
      </div>
    </div>
  )
}

function PairDetailModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  // Mounted only while a row is selected (caller gates + remounts via `key`), so
  // open once imperatively. This avoids the controlled-`open` + conditional-
  // content race that emptied the box mid close-animation.
  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  return (
    <Modal dialogRef={dialogRef} onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-mono text-sm font-semibold">{row.id}</h3>
          <p className="text-sm text-base-content/70">{row.label}</p>
        </div>

        {/* The combined sample: real foreground on the real surface — the way
            WebAIM and other contrast tools preview a pair, because contrast is
            a property of the combination, not two isolated swatches. */}
        <div
          className="flex flex-col items-center justify-center gap-2 rounded-box border border-base-300 p-8"
          style={{ backgroundColor: row.bgHex, color: row.fgHex }}
        >
          <span className="text-2xl font-semibold" aria-hidden="true">
            {t("accessibility.detail.sampleHeading")}
          </span>
          <span className="text-sm" aria-hidden="true">
            {t("accessibility.detail.sampleBody")}
          </span>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <ColorRef
            hex={row.fgHex}
            role={t("accessibility.detail.foreground")}
          />
          <ColorRef
            hex={row.bgHex}
            role={t("accessibility.detail.background")}
          />
        </div>

        <div className="rounded-box border border-base-300 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-base-content/70">
              {t("accessibility.detail.ratio")}
            </span>
            <span className="font-mono text-2xl font-bold tabular-nums">
              {row.ratio.toFixed(2)}:1
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-sm text-base-content/70">
              {t("accessibility.detail.minimum", { floor: row.floor })}
            </span>
            <StatusCell row={row} />
          </div>
          {row.withinMargin && (
            <p className="mt-2 text-sm text-base-content/70">
              {t("accessibility.marginInfo", {
                ratio: row.ratio.toFixed(2),
                floor: row.floor,
                margin: row.margin,
              })}
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}

function StatusCell({ row }: { row: Row }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1">
      <Badge tone={STATUS_TONE[row.status]}>
        {t(`accessibility.status.${row.status}`)}
      </Badge>
      {row.withinMargin && (
        <span
          className="tooltip tooltip-left cursor-help text-base-content/60 hover:text-base-content"
          data-tip={t("accessibility.marginInfo", {
            ratio: row.ratio.toFixed(2),
            floor: row.floor,
            margin: row.margin,
          })}
        >
          <Info aria-hidden="true" className="size-4" />
        </span>
      )}
    </div>
  )
}

function ThemeTable({
  theme,
  onOpenRow,
}: {
  theme: AuditTheme
  onOpenRow: (row: Row) => void
}) {
  const { t } = useTranslation()
  return (
    <Card radius="xl" shadow={false}>
      <Card.Body className="gap-3 p-4">
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t("accessibility.col.preview")}</th>
                <th>{t("accessibility.col.pair")}</th>
                <th>{t("accessibility.col.description")}</th>
                <th className="text-end">{t("accessibility.col.ratio")}</th>
                <th className="text-end">{t("accessibility.col.floor")}</th>
                <th>{t("accessibility.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {theme.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <ColorPreviewButton row={r} onOpen={() => onOpenRow(r)} />
                  </td>
                  <td className="font-mono text-xs">{r.id}</td>
                  <td>
                    {r.label}
                    <span className="block text-xs text-base-content/60">
                      {r.size}
                    </span>
                  </td>
                  <td className="text-end font-mono tabular-nums">
                    {r.ratio.toFixed(2)}:1
                  </td>
                  <td className="text-end font-mono tabular-nums text-base-content/70">
                    {r.floor}:1
                  </td>
                  <td>
                    <StatusCell row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card.Body>
    </Card>
  )
}

function VpatConformanceTable({ vpat }: { vpat: Vpat }) {
  const { t } = useTranslation()
  const byPrinciple = PRINCIPLE_ORDER.map((principle) => ({
    principle,
    rows: vpat.criteria.filter((c) => c.principle === principle),
  })).filter((g) => g.rows.length > 0)

  return (
    <Card radius="xl" shadow={false}>
      <Card.Body className="gap-4 p-4">
        {byPrinciple.map(({ principle, rows }) => (
          <div key={principle} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{principle}</h3>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>{t("accessibility.vpat.col.criterion")}</th>
                    <th>{t("accessibility.vpat.col.level")}</th>
                    <th>{t("accessibility.vpat.col.conformance")}</th>
                    <th>{t("accessibility.vpat.col.remarks")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="whitespace-nowrap">
                        <span className="font-mono text-xs">{c.id}</span>{" "}
                        {c.name}
                      </td>
                      <td className="font-mono text-xs">{c.level}</td>
                      <td>
                        <Badge tone={VPAT_TONE[c.status]}>
                          {t(`accessibility.vpat.status.${c.status}`)}
                        </Badge>
                      </td>
                      <td className="text-xs text-base-content/70">
                        {c.remark}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Card.Body>
    </Card>
  )
}

function VpatSection() {
  const { t } = useTranslation()
  const [vpat, setVpat] = useState<Vpat | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    fetch("/vpat-report.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Vpat>
      })
      .then((data) => {
        if (active) setVpat(data)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <section className="flex flex-col gap-4" aria-labelledby="vpat-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="vpat-heading" className="text-xl font-bold tracking-tight">
            {t("accessibility.vpat.heading")}
          </h2>
          <div className="mt-1 text-sm text-base-content/70">
            {t("accessibility.vpat.subtitle")}
          </div>
        </div>
        {vpat && (
          <div className="flex flex-wrap gap-2">
            <Button as="a" href="/VPAT.md" download variant="outline" size="sm">
              {t("accessibility.vpat.downloadWcag")}
            </Button>
            <Button
              as="a"
              href="/VPAT-INT.md"
              download
              variant="outline"
              size="sm"
            >
              {t("accessibility.vpat.downloadInt")}
            </Button>
          </div>
        )}
      </div>

      {error && <Alert tone="error">{t("accessibility.vpat.loadError")}</Alert>}

      {!error && !vpat && (
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      )}

      {vpat && (
        <>
          <div className="text-sm text-base-content/70">
            {t("accessibility.vpat.summary", {
              total: vpat.summary.total,
              supports: vpat.summary.byStatus.supports,
              notEvaluated: vpat.summary.byStatus.notEvaluated,
            })}{" "}
            · {t("accessibility.vpat.generated", { generated: vpat.generated })}
          </div>
          <VpatConformanceTable vpat={vpat} />
        </>
      )}
    </section>
  )
}

export default function AccessibilityPage() {
  const { t } = useTranslation()
  useDocumentTitle(t("accessibility.title"))
  const [audit, setAudit] = useState<Audit | null>(null)
  const [error, setError] = useState(false)
  const [activeTheme, setActiveTheme] = useState<string | null>(null)
  const [selectedRow, setSelectedRow] = useState<Row | null>(null)

  useEffect(() => {
    let active = true
    fetch("/contrast-audit.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Audit>
      })
      .then((data) => {
        if (!active) return
        setAudit(data)
        setActiveTheme(data.themes[0]?.theme ?? null)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const shownTheme = audit?.themes.find((th) => th.theme === activeTheme)
  const marginCount = audit?.summary.marginMisses ?? 0

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 2xl:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("accessibility.title")}
          </h1>
          <div className="mt-1 text-sm text-base-content/70">
            {t("accessibility.subtitle")}
          </div>
        </div>
        <Button
          as="a"
          href="/CONTRAST-AUDIT.md"
          download
          variant="outline"
          size="sm"
        >
          {t("accessibility.download")}
        </Button>
      </div>

      {error && <Alert tone="error">{t("accessibility.loadError")}</Alert>}

      {!error && !audit && (
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      )}

      {audit && (
        <>
          <details className="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
            <summary className="collapse-title text-sm font-medium">
              {!audit.summary.allPass
                ? t("accessibility.summaryFail", {
                    failures: audit.summary.failures,
                  })
                : marginCount > 0
                  ? t("accessibility.summaryPassMargin", {
                      total: audit.summary.total,
                      count: marginCount,
                    })
                  : t("accessibility.summaryPass", {
                      total: audit.summary.total,
                    })}
            </summary>
            <div className="collapse-content flex flex-col gap-4 text-sm text-base-content/70">
              <p>{t("accessibility.criteria.standardText")}</p>
              <div>
                <p className="font-medium text-base-content">
                  {t("accessibility.criteria.thresholdsHeading")}
                </p>
                <ul className="mt-1 list-disc ps-5">
                  <li>
                    {t("accessibility.criteria.bodyText", {
                      body: audit.thresholds.body,
                    })}
                  </li>
                  <li>
                    {t("accessibility.criteria.largeText", {
                      large: audit.thresholds.large,
                    })}
                  </li>
                  <li>
                    {t("accessibility.criteria.nonText", {
                      nonText: audit.thresholds.nonText,
                    })}
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-base-content">
                  {t("accessibility.criteria.marginHeading")}
                </p>
                <ul className="mt-1 list-disc ps-5">
                  <li>
                    {t("accessibility.criteria.marginBody", {
                      body: audit.margins.body,
                    })}
                  </li>
                  <li>
                    {t("accessibility.criteria.marginLarge", {
                      large: audit.margins.large,
                    })}
                  </li>
                  <li>
                    {t("accessibility.criteria.marginNonText", {
                      nonText: audit.margins.nonText,
                    })}
                  </li>
                </ul>
                <p className="mt-1">{t("accessibility.criteria.marginWhy")}</p>
              </div>
              <div>
                <p className="font-medium text-base-content">
                  {t("accessibility.legend.heading")}
                </p>
                <div className="mt-1 flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Badge tone="success">
                      {t("accessibility.status.pass")}
                    </Badge>
                    {t("accessibility.legend.pass")}
                  </span>
                  <span className="flex items-center gap-2">
                    <Info aria-hidden="true" className="size-4" />
                    {t("accessibility.legend.passMargin")}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone="error">{t("accessibility.status.fail")}</Badge>
                    {t("accessibility.legend.fail")}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">
                      {t("accessibility.status.exempt")}
                    </Badge>
                    {t("accessibility.legend.exempt")}
                  </span>
                </div>
              </div>
              <p>
                {t("accessibility.criteria.generated", {
                  generated: audit.generated,
                })}
              </p>
            </div>
          </details>

          <div role="tablist" className="tabs-boxed tabs w-fit">
            {audit.themes.map((th) => (
              <button
                key={th.theme}
                type="button"
                role="tab"
                aria-selected={th.theme === activeTheme}
                className={`tab ${th.theme === activeTheme ? "tab-active" : ""}`}
                onClick={() => setActiveTheme(th.theme)}
              >
                {th.label}
              </button>
            ))}
          </div>

          {shownTheme && (
            <ThemeTable theme={shownTheme} onOpenRow={setSelectedRow} />
          )}
        </>
      )}

      {selectedRow && (
        <PairDetailModal
          key={selectedRow.id}
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}

      <div className="divider" role="separator" />

      <VpatSection />
    </div>
  )
}
