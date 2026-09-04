import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import { Button, Card } from "@/components/ui"
import {
  CONFORMANCE_LABEL,
  hasGenericRemark,
  PRINCIPLE_ORDER,
  type Criterion,
  type WcagPrinciple,
} from "@/util/a11y/vpatModel"
import { DownloadIcon, FileIcon } from "@/components/ui/icons"

import { useContrastAudit, useVpatReport, type Audit, type Vpat } from "../data"

// Which report the browser print / Save-as-PDF should render. The full report
// prints every document; the others print just their own.
export type PrintTarget = "vpat" | "contrast" | "full"

// One report row: title + description + a Markdown download link and a PDF
// (browser print / Save as PDF) button. The .md files are build-emitted into
// dist/ and served at their root path; the PDF is rendered client-side from the
// same source (see PrintableReport) and triggered via onPrint.
function DownloadRow({
  href,
  title,
  description,
  onPrint,
}: {
  href: string
  title: string
  description: string
  onPrint: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <p className="text-sm text-base-content/70">{description}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button as="a" href={href} download variant="outline" size="sm">
          <DownloadIcon aria-hidden="true" className="size-4" />
          {t("accessibility.downloads.markdownAction")}
        </Button>
        <Button onClick={onPrint} variant="outline" size="sm">
          <FileIcon aria-hidden="true" className="size-4" />
          {t("accessibility.downloads.pdfAction")}
        </Button>
      </div>
    </div>
  )
}

// A single place to find and download every report, so the report tabs stay
// focused on reading rather than repeating download controls. Each row offers
// Markdown (a build-emitted .md) and PDF (browser print of the client-rendered
// report). The PDF flow sets a print target, waits one paint for the portaled
// print DOM to render, then opens the print dialog and clears the target.
export function DownloadsSection() {
  const { t } = useTranslation()
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null)

  useEffect(() => {
    if (!printTarget) return
    // Defer to the next frame so the portaled PrintableReport has painted the
    // requested document before the browser snapshots it for the dialog.
    const id = requestAnimationFrame(() => {
      window.print()
      setPrintTarget(null)
    })
    return () => cancelAnimationFrame(id)
  }, [printTarget])

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="downloads-heading"
    >
      <h2 id="downloads-heading" className="sr-only">
        {t("accessibility.downloads.heading")}
      </h2>
      <Card shadow={false}>
        <Card.Body className="divide-y divide-base-300 p-4">
          <DownloadRow
            href="/VPAT.md"
            title={t("accessibility.downloads.vpatWcagTitle")}
            description={t("accessibility.downloads.vpatWcagDesc")}
            onPrint={() => setPrintTarget("vpat")}
          />
          <DownloadRow
            href="/CONTRAST-AUDIT.md"
            title={t("accessibility.downloads.contrastTitle")}
            description={t("accessibility.downloads.contrastDesc")}
            onPrint={() => setPrintTarget("contrast")}
          />
          <DownloadRow
            href="/ACCESSIBILITY-REPORT.md"
            title={t("accessibility.downloads.fullTitle")}
            description={t("accessibility.downloads.fullDesc")}
            onPrint={() => setPrintTarget("full")}
          />
        </Card.Body>
      </Card>
      <PrintableReport target={printTarget} />
    </section>
  )
}

// The VPAT conformance tables as print HTML.
function PrintableVpat({ vpat }: { vpat: Vpat }) {
  const { t } = useTranslation()
  const criteriaByPrinciple = useMemo(() => {
    const map = {} as Record<WcagPrinciple, Criterion[]>
    for (const p of PRINCIPLE_ORDER) map[p] = []
    for (const c of vpat.criteria) map[c.principle].push(c)
    return map
  }, [vpat])

  return (
    <section className="report-doc">
      <h1>{t("accessibility.print.reportTitle", { product: vpat.product })}</h1>
      <p className="report-meta">
        {t("accessibility.print.reportMeta", {
          standard: vpat.standard,
          target: vpat.target,
          versions: vpat.wcagVersions.join(", "),
          date: vpat.generated,
        })}
      </p>
      <p className="report-summary">
        {t("accessibility.print.vpatSummary", {
          total: vpat.summary.total,
          supports: vpat.summary.byStatus.supports,
          partially: vpat.summary.byStatus.partially,
          doesNotSupport: vpat.summary.byStatus.doesNotSupport,
          notApplicable: vpat.summary.byStatus.notApplicable,
          notEvaluated: vpat.summary.byStatus.notEvaluated,
        })}
      </p>
      {PRINCIPLE_ORDER.filter((p) => criteriaByPrinciple[p].length > 0).map(
        (principle) => (
          <div key={principle}>
            <h2>{principle}</h2>
            <table>
              <thead>
                <tr>
                  <th>{t("accessibility.vpat.col.criterion")}</th>
                  <th>{t("accessibility.vpat.col.level")}</th>
                  <th>{t("accessibility.vpat.col.conformance")}</th>
                  <th>{t("accessibility.vpat.col.assessed")}</th>
                  <th>{t("accessibility.vpat.col.remarks")}</th>
                </tr>
              </thead>
              <tbody>
                {criteriaByPrinciple[principle].map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="mono report-sub">{c.id}</span> {c.name}
                    </td>
                    <td className="mono">{c.level}</td>
                    <td>{CONFORMANCE_LABEL[c.status]}</td>
                    <td className="mono report-sub">
                      {c.assessed ?? vpat.generated}
                    </td>
                    <td>{hasGenericRemark(c) ? "—" : c.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </section>
  )
}

// The color-contrast audit as print HTML, including a live foreground-on-surface
// preview swatch per pair (mirroring the on-screen preview).
function PrintableContrast({ contrast }: { contrast: Audit }) {
  const { t } = useTranslation()
  return (
    <section className="report-doc">
      <h1>{t("accessibility.print.contrastTitle")}</h1>
      <p className="report-meta">
        {t("accessibility.print.contrastMeta", { date: contrast.generated })}
      </p>
      {contrast.themes.map((th) => (
        <div key={th.theme}>
          <h2>{th.label}</h2>
          <table className="contrast-table">
            <thead>
              <tr>
                <th>{t("accessibility.col.preview")}</th>
                <th>{t("accessibility.col.pair")}</th>
                <th>{t("accessibility.col.description")}</th>
                <th>{t("accessibility.print.colColors")}</th>
                <th className="num">{t("accessibility.col.ratio")}</th>
                <th className="num">{t("accessibility.col.floor")}</th>
                <th>{t("accessibility.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {th.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span
                      className="contrast-swatch"
                      style={{ backgroundColor: r.bgHex, color: r.fgHex }}
                    >
                      {r.kind === "text" ? "Aa" : "▭"}
                    </span>
                  </td>
                  <td className="mono">{r.id}</td>
                  <td>
                    {r.label}
                    <span className="report-sub"> ({r.size})</span>
                  </td>
                  <td className="mono report-sub">
                    {r.fgHex} / {r.bgHex}
                  </td>
                  <td className="num mono">{r.ratio.toFixed(2)}:1</td>
                  <td className="num mono">{r.floor}:1</td>
                  <td>
                    {t(`accessibility.status.${r.status}`)}
                    {r.withinMargin
                      ? ` ${t("accessibility.print.belowMargin", { margin: r.margin })}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  )
}

// The report(s) selected by `target`, rendered as plain semantic HTML for
// browser print / Save as PDF. Portaled to <body> (a sibling of #root) and
// hidden on screen. Portaling matters: the print CSS hides #root, and if this
// lived inside #root a display:none ancestor would hide it too (an ancestor's
// display:none can't be overridden by a descendant), leaving a blank PDF. Built
// from the same JSON the page already fetches — the VPAT and the contrast audit
// — so the PDF is a rendering of the single source, never a separate assessment.
// Theme-agnostic (black on white, bordered tables) so the PDF reads as a clean
// document regardless of theme.
function PrintableReport({ target }: { target: PrintTarget | null }) {
  const { data: vpat = null } = useVpatReport()
  const { data: contrast = null } = useContrastAudit()

  // Nothing requested, or data not ready: nothing to print (and nothing to portal).
  if (!target || !vpat || !contrast) return null

  const showVpat = target === "vpat" || target === "full"
  const showContrast = target === "contrast" || target === "full"

  return createPortal(
    <div className="report-print" aria-hidden="true">
      {showVpat && <PrintableVpat vpat={vpat} />}
      {showContrast && <PrintableContrast contrast={contrast} />}
    </div>,
    document.body,
  )
}
