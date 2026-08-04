import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Info } from "lucide-react"

import { Alert, Badge, Button, Card, Modal } from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Public /accessibility page: the human-readable rendering of the WCAG 2.2
// contrast audit. Fetches the build-emitted contrast-audit.json (the source of
// truth, always current with the shipped palette) and renders it as a themed
// table with live color previews; the .md download links the sibling artifact
// (which keeps both themes in one document). No auth — an ADA/VPAT reviewer can
// open it directly.

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
      className="flex h-9 w-14 items-center justify-center rounded border border-base-300 text-sm font-semibold transition hover:ring-2 hover:ring-primary/40"
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

function PairDetailModal({
  row,
  onClose,
}: {
  row: Row | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Modal open={row !== null} onClose={onClose} size="lg">
      {row && (
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
      )}
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
          <Alert tone={audit.summary.allPass ? "success" : "error"}>
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
          </Alert>

          <details className="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
            <summary className="collapse-title text-sm font-medium">
              {t("accessibility.criteria.toggle")}
            </summary>
            <div className="collapse-content flex flex-col gap-2 text-sm text-base-content/70">
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

          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-base-content/70">
            <span className="flex items-center gap-1">
              <Badge tone="success">{t("accessibility.status.pass")}</Badge>
              {t("accessibility.legend.pass")}
            </span>
            <span className="flex items-center gap-1">
              <Info aria-hidden="true" className="size-4" />
              {t("accessibility.legend.passMargin")}
            </span>
            <span className="flex items-center gap-1">
              <Badge tone="error">{t("accessibility.status.fail")}</Badge>
              {t("accessibility.legend.fail")}
            </span>
            <span className="flex items-center gap-1">
              <Badge tone="neutral">{t("accessibility.status.exempt")}</Badge>
              {t("accessibility.legend.exempt")}
            </span>
          </div>
        </>
      )}

      <PairDetailModal row={selectedRow} onClose={() => setSelectedRow(null)} />
    </div>
  )
}
