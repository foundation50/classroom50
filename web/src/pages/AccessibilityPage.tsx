import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Info, CircleDashed, Download, Printer } from "lucide-react"

import { Alert, Badge, Button, Card, Modal, Toolbar, cx } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { DrawerShell } from "@/components/drawer"
import {
  sectionFromHash,
  type AccessibilitySection,
} from "@/util/a11y/accessibilitySections"
import type { BadgeTone } from "@/types/badgeTone"
import {
  CONFORMANCE_TONE,
  CONFORMANCE_LABEL,
  hasGenericRemark,
  PRINCIPLE_ORDER,
  type ConformanceLevel,
  type Criterion,
  type WcagPrinciple,
} from "@/util/a11y/vpatModel"
import type { VpatReportJson } from "@/util/a11y/vpatReport"
import { ACCESSIBILITY_ISSUE_URL } from "@/version"
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

type Vpat = Pick<
  VpatReportJson,
  | "schema"
  | "product"
  | "generated"
  | "summary"
  | "criteria"
  | "standard"
  | "target"
>

// One shared fetch of the build-emitted vpat-report.json, so the conformance
// table and the statement's "last reviewed" date read from a single request
// (the sections are hash-routed, so a plain useEffect fetch would re-download
// on every switch between them). Static asset, so cache indefinitely.
function useVpatReport() {
  return useQuery({
    queryKey: ["vpat-report"],
    queryFn: async (): Promise<Vpat> => {
      const res = await fetch("/vpat-report.json")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<Vpat>
    },
    staleTime: Infinity,
  })
}

// One shared fetch of the build-emitted contrast-audit.json (static asset), so
// the contrast table and the printable full report read from a single request.
function useContrastAudit() {
  return useQuery({
    queryKey: ["contrast-audit"],
    queryFn: async (): Promise<Audit> => {
      const res = await fetch("/contrast-audit.json")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<Audit>
    },
    staleTime: Infinity,
  })
}

// Tone -> the small status-dot swatch class. One source, shared by the VPAT stat
// chips (Badge owns the badge recipe; this is only the bare dot).
const TONE_DOT_CLASS: Record<BadgeTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  neutral: "bg-base-content/40",
  info: "bg-info",
  primary: "bg-primary",
  secondary: "bg-secondary",
}

// The order the VPAT summary chips + status filter render in: best-first, then
// the out-of-band statuses (not applicable, not evaluated) last.
const VPAT_STATUS_ORDER: ConformanceLevel[] = [
  "supports",
  "partially",
  "doesNotSupport",
  "notApplicable",
  "notEvaluated",
]

// Shared boxed-tab recipe so the active tab reads unambiguously (solid primary
// fill) and inactive tabs stay clickable-looking. One source for both the
// principle tabs and the theme tabs.
function tabClass(active: boolean): string {
  return cx(
    "tab cursor-pointer gap-1.5",
    active
      ? "tab-active rounded-box !bg-primary font-semibold !text-primary-content"
      : "text-base-content/60 hover:text-base-content",
  )
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

type VpatFilter = ConformanceLevel | "all"
type VpatSort = "criterion" | "status"

const STATUS_SORT_WEIGHT: Record<ConformanceLevel, number> = {
  supports: 0,
  partially: 1,
  doesNotSupport: 2,
  notApplicable: 3,
  notEvaluated: 4,
}

function VpatConformanceTable({
  criteria,
  generated,
}: {
  criteria: Criterion[]
  generated: string
}) {
  const { t } = useTranslation()
  const [activePrinciple, setActivePrinciple] =
    useState<WcagPrinciple>("Perceivable")

  // Counts per principle reflect the current search/filter so a tab shows how
  // many rows it holds (and an emptied tab reads 0 rather than looking broken).
  const countByPrinciple = useMemo(() => {
    const counts = {} as Record<WcagPrinciple, number>
    for (const p of PRINCIPLE_ORDER)
      counts[p] = criteria.filter((c) => c.principle === p).length
    return counts
  }, [criteria])

  const rows = criteria.filter((c) => c.principle === activePrinciple)

  return (
    <Card radius="xl" shadow={false}>
      <Card.Body className="gap-4 p-4">
        <div
          role="tablist"
          aria-label={t("accessibility.vpat.principleTabsAria")}
          className="tabs-boxed tabs w-fit"
        >
          {PRINCIPLE_ORDER.map((principle) => (
            <button
              key={principle}
              type="button"
              role="tab"
              aria-selected={principle === activePrinciple}
              className={tabClass(principle === activePrinciple)}
              onClick={() => setActivePrinciple(principle)}
            >
              {principle}
              <span
                className={cx(
                  "text-xs tabular-nums",
                  principle === activePrinciple
                    ? "text-primary-content/70"
                    : "text-base-content/50",
                )}
              >
                {countByPrinciple[principle]}
              </span>
            </button>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-base-content/60">
            <CircleDashed aria-hidden="true" className="size-5" />
            {t("accessibility.vpat.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr>
                  <th className="w-64">
                    {t("accessibility.vpat.col.criterion")}
                  </th>
                  <th className="w-14">{t("accessibility.vpat.col.level")}</th>
                  <th className="w-40">
                    {t("accessibility.vpat.col.conformance")}
                  </th>
                  <th className="w-28">
                    {t("accessibility.vpat.col.assessed")}
                  </th>
                  <th className="min-w-[24rem]">
                    {t("accessibility.vpat.col.remarks")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="align-top">
                      <span className="font-mono text-xs text-base-content/60">
                        {c.id}
                      </span>{" "}
                      {c.name}
                    </td>
                    <td className="align-top font-mono text-xs">{c.level}</td>
                    <td className="align-top">
                      <Badge tone={CONFORMANCE_TONE[c.status]}>
                        {t(`accessibility.vpat.status.${c.status}`)}
                      </Badge>
                    </td>
                    <td className="align-top font-mono text-xs whitespace-nowrap text-base-content/60">
                      {c.assessed ?? generated}
                    </td>
                    <td className="align-top text-sm text-base-content/70">
                      {hasGenericRemark(c) ? (
                        <span className="text-base-content/40">—</span>
                      ) : (
                        c.remark
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card.Body>
    </Card>
  )
}

// One compact summary chip that doubles as a status filter toggle: a status
// dot, count, and label. Clicking filters the table to that status (and toggles
// back to "all" when the active chip is re-clicked); the active chip is ringed.
function VpatSummaryChip({
  status,
  value,
  active,
  onClick,
}: {
  status: ConformanceLevel
  value: number
  active: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary/10 ring-1 ring-primary"
          : "border-base-300 hover:border-primary/50 hover:bg-base-200",
      )}
    >
      <span
        className={cx(
          "size-2 rounded-full",
          TONE_DOT_CLASS[CONFORMANCE_TONE[status]],
        )}
        aria-hidden="true"
      />
      <span className="tabular-nums font-semibold">{value}</span>
      <span className="text-base-content/70">
        {t(`accessibility.vpat.status.${status}`)}
      </span>
    </button>
  )
}

function VpatSection() {
  const { t } = useTranslation()
  const { data: vpat = null, isError: error } = useVpatReport()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<VpatFilter>("all")
  const [sort, setSort] = useState<VpatSort>("criterion")

  const visibleCriteria = useMemo(() => {
    if (!vpat) return []
    const q = query.trim().toLowerCase()
    const filtered = vpat.criteria.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false
      if (!q) return true
      return (
        c.id.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.remark.toLowerCase().includes(q)
      )
    })
    if (sort === "status") {
      return [...filtered].sort(
        (a, b) => STATUS_SORT_WEIGHT[a.status] - STATUS_SORT_WEIGHT[b.status],
      )
    }
    return filtered
  }, [vpat, query, filter, sort])

  const hasActiveFilter = query.trim() !== "" || filter !== "all"

  // Clicking a summary chip filters to that status, or clears back to "all" when
  // the already-active chip is clicked again.
  const toggleFilter = (status: ConformanceLevel) =>
    setFilter((cur) => (cur === status ? "all" : status))

  return (
    <section className="flex flex-col gap-4" aria-labelledby="vpat-heading">
      <h2 id="vpat-heading" className="sr-only">
        {t("accessibility.vpat.heading")}
      </h2>
      {vpat && (
        <div className="flex flex-wrap items-center gap-2">
          {VPAT_STATUS_ORDER.filter((s) => vpat.summary.byStatus[s] > 0).map(
            (status) => (
              <VpatSummaryChip
                key={status}
                status={status}
                value={vpat.summary.byStatus[status]}
                active={filter === status}
                onClick={() => toggleFilter(status)}
              />
            ),
          )}
        </div>
      )}

      {error && <Alert tone="error">{t("accessibility.vpat.loadError")}</Alert>}

      {!error && !vpat && (
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      )}

      {vpat && (
        <>
          <Toolbar>
            <Toolbar.Search
              placeholder={t("accessibility.vpat.searchPlaceholder")}
              value={query}
              onChange={setQuery}
              ariaLabel={t("accessibility.vpat.searchAria")}
            />
            <Toolbar.FilterSelect
              label={t("accessibility.vpat.filterLabel")}
              value={filter}
              onChange={(e) => setFilter(e.target.value as VpatFilter)}
              aria-label={t("accessibility.vpat.filterAria")}
            >
              <option value="all">{t("accessibility.vpat.filterAll")}</option>
              {VPAT_STATUS_ORDER.map((status) => (
                <option key={status} value={status}>
                  {t(`accessibility.vpat.status.${status}`)}
                </option>
              ))}
            </Toolbar.FilterSelect>
            {hasActiveFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("")
                  setFilter("all")
                }}
              >
                {t("accessibility.vpat.clearFilter")}
              </Button>
            )}
            <Toolbar.Trailing>
              <Toolbar.FilterSelect
                label={t("accessibility.vpat.sortBy")}
                value={sort}
                onChange={(e) => setSort(e.target.value as VpatSort)}
                aria-label={t("accessibility.vpat.sortBy")}
              >
                <option value="criterion">
                  {t("accessibility.vpat.sort.criterion")}
                </option>
                <option value="status">
                  {t("accessibility.vpat.sort.status")}
                </option>
              </Toolbar.FilterSelect>
            </Toolbar.Trailing>
          </Toolbar>

          <VpatConformanceTable
            criteria={visibleCriteria}
            generated={vpat.generated}
          />

          <p className="text-xs text-base-content/60">
            {t("accessibility.vpat.generated", { generated: vpat.generated })}
          </p>
        </>
      )}
    </section>
  )
}

function ContrastSection() {
  const { t } = useTranslation()
  const { data: audit = null, isError: error } = useContrastAudit()
  // null = "no explicit pick yet"; the shown theme then defaults to the first.
  // Deriving the shown theme (rather than syncing it in an effect) keeps the
  // user's later choice sticky without a setState-in-effect.
  const [pickedTheme, setPickedTheme] = useState<string | null>(null)
  const [selectedRow, setSelectedRow] = useState<Row | null>(null)

  const activeTheme = pickedTheme ?? audit?.themes[0]?.theme ?? null
  const shownTheme = audit?.themes.find((th) => th.theme === activeTheme)
  const marginCount = audit?.summary.marginMisses ?? 0

  return (
    <section className="flex flex-col gap-4" aria-labelledby="contrast-heading">
      <h2 id="contrast-heading" className="sr-only">
        {t("accessibility.title")}
      </h2>

      {error && <Alert tone="error">{t("accessibility.loadError")}</Alert>}

      {!error && !audit && (
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      )}

      {audit && (
        <>
          <p className="text-sm text-base-content/70">
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
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" className="tabs-boxed tabs w-fit">
              {audit.themes.map((th) => (
                <button
                  key={th.theme}
                  type="button"
                  role="tab"
                  aria-selected={th.theme === activeTheme}
                  className={tabClass(th.theme === activeTheme)}
                  onClick={() => setPickedTheme(th.theme)}
                >
                  {th.label}
                </button>
              ))}
            </div>
          </div>

          {shownTheme && (
            <ThemeTable theme={shownTheme} onOpenRow={setSelectedRow} />
          )}

          <details className="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
            <summary className="collapse-title text-sm font-medium">
              {t("accessibility.criteria.aboutHeading")}
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
              <p className="text-xs">
                {t("accessibility.criteria.generated", {
                  generated: audit.generated,
                })}
              </p>
            </div>
          </details>
        </>
      )}

      {selectedRow && (
        <PairDetailModal
          key={selectedRow.id}
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </section>
  )
}

// The public accessibility statement, following the plain-language shape W3C
// recommends: who it's for, how we measure up, known limitations, and how to
// give feedback. The "last reviewed" date reuses the VPAT report's generation
// date so it can't drift from the actual assessment.
function StatementSection() {
  const { t } = useTranslation()
  const generated = useVpatReport().data?.generated ?? null

  return (
    <section aria-labelledby="statement-heading">
      <Card radius="xl" shadow={false}>
        <Card.Body className="max-w-2xl gap-6 p-6">
          <h2
            id="statement-heading"
            className="text-2xl font-bold tracking-tight"
          >
            {t("accessibility.statement.heading")}
          </h2>
          <p className="text-base-content/80">
            {t("accessibility.statement.intro")}
          </p>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
              {t("accessibility.statement.targetHeading")}
            </h3>
            <p className="text-base-content/80">
              {t("accessibility.statement.target")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
              {t("accessibility.statement.limitationsHeading")}
            </h3>
            <p className="text-base-content/80">
              {t("accessibility.statement.limitations")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
              {t("accessibility.statement.feedbackHeading")}
            </h3>
            <p className="text-base-content/80">
              {t("accessibility.statement.feedback")}{" "}
              <a
                href={ACCESSIBILITY_ISSUE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="link link-primary"
              >
                {t("accessibility.statement.feedbackLink")}
              </a>
              .
            </p>
          </div>

          {generated && (
            <p className="text-xs text-base-content/50">
              {t("accessibility.statement.updated", { date: generated })}
            </p>
          )}
        </Card.Body>
      </Card>
    </section>
  )
}

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
          <Download aria-hidden="true" className="size-4" />
          {t("accessibility.downloads.markdownAction")}
        </Button>
        <Button onClick={onPrint} variant="outline" size="sm">
          <Printer aria-hidden="true" className="size-4" />
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
function DownloadsSection() {
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
      <Card radius="xl" shadow={false}>
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

// The full report, rendered as plain semantic HTML for browser print / Save as
// PDF. Kept in the DOM but hidden on screen (`.report-print` is display:none
// except under @media print); the "Print / Save as PDF" control just calls
// window.print(). Built from the same JSON the page already fetches — the VPAT
// Which report the browser print / Save-as-PDF should render. The full report
// prints both documents; the others print just their own.
type PrintTarget = "vpat" | "contrast" | "full"

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
// from the same JSON the page already fetches — the VPAT (both editions share
// one criteria set) and the contrast audit — so the PDF is a rendering of the
// single source, never a separate assessment. Theme-agnostic (black on white,
// bordered tables) so the PDF reads as a clean document regardless of theme.
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

export default function AccessibilityPage() {
  const { t } = useTranslation()
  useDocumentTitle(t("accessibility.pageTitle"))
  // The URL hash is the single source of truth for the active section, so the
  // public drawer's section links (and shared/bookmarked deep links) drive it.
  const hash = useRouterState({ select: (s) => s.location.hash })
  const section = sectionFromHash(hash)

  return (
    <DrawerShell>
      <PageShell>
        <PageHeader
          title={t("accessibility.pageTitle")}
          subtitle={t("accessibility.pageSubtitle")}
        />

        <SectionPanel section={section} />
      </PageShell>
    </DrawerShell>
  )
}

// Route the active section to its panel via a lookup so a new AccessibilitySection
// must register one here (the old ternary chain silently fell through to Downloads).
const SECTION_PANEL: Record<AccessibilitySection, () => ReactElement> = {
  conformance: VpatSection,
  "color-contrast": ContrastSection,
  statement: StatementSection,
  downloads: DownloadsSection,
}

function SectionPanel({ section }: { section: AccessibilitySection }) {
  const Panel = SECTION_PANEL[section]
  return <Panel />
}
