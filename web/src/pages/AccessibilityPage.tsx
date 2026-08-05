import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Info, CircleDashed } from "lucide-react"

import {
  Alert,
  Badge,
  Button,
  Card,
  Modal,
  Select,
  StatCard,
  cx,
} from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import { hasGenericRemark } from "@/util/vpatModel"
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
  evidence?: "contrast" | "automated" | "manual" | "architectural"
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

// The order the VPAT summary chips render in — worst-first so failures lead.
const VPAT_STATUS_ORDER: VpatConformance[] = [
  "doesNotSupport",
  "partially",
  "supports",
  "notApplicable",
  "notEvaluated",
]

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

type VpatFilter = VpatConformance | "all"
type VpatSort = "criterion" | "status"

const STATUS_SORT_WEIGHT: Record<VpatConformance, number> = {
  doesNotSupport: 0,
  partially: 1,
  supports: 2,
  notApplicable: 3,
  notEvaluated: 4,
}

function PrincipleProgress({ rows }: { rows: VpatCriterion[] }) {
  const evaluated = rows.filter((c) => c.status !== "notEvaluated").length
  const pct =
    rows.length === 0 ? 0 : Math.round((evaluated / rows.length) * 100)
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-24 overflow-hidden rounded-full bg-base-300"
        role="presentation"
      >
        <div
          className="h-full rounded-full bg-success transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-base-content/60">
        {evaluated}/{rows.length}
      </span>
    </div>
  )
}

function VpatConformanceTable({ criteria }: { criteria: VpatCriterion[] }) {
  const { t } = useTranslation()
  const byPrinciple = PRINCIPLE_ORDER.map((principle) => ({
    principle,
    rows: criteria.filter((c) => c.principle === principle),
  })).filter((g) => g.rows.length > 0)

  if (byPrinciple.length === 0) {
    return (
      <Card radius="xl" shadow={false}>
        <Card.Body className="items-center gap-2 p-8 text-center text-sm text-base-content/60">
          <CircleDashed aria-hidden="true" className="size-5" />
          {t("accessibility.vpat.empty")}
        </Card.Body>
      </Card>
    )
  }

  return (
    <Card radius="xl" shadow={false}>
      <Card.Body className="gap-5 p-4">
        {byPrinciple.map(({ principle, rows }) => (
          <div key={principle} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{principle}</h3>
              <PrincipleProgress rows={rows} />
            </div>
            <div className="overflow-x-auto">
              <table className="table table-sm w-full">
                <thead>
                  <tr>
                    <th className="w-72">
                      {t("accessibility.vpat.col.criterion")}
                    </th>
                    <th className="w-16">
                      {t("accessibility.vpat.col.level")}
                    </th>
                    <th className="w-44">
                      {t("accessibility.vpat.col.conformance")}
                    </th>
                    <th>{t("accessibility.vpat.col.remarks")}</th>
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
                        <Badge tone={VPAT_TONE[c.status]}>
                          {t(`accessibility.vpat.status.${c.status}`)}
                        </Badge>
                      </td>
                      <td className="align-top text-xs text-base-content/70">
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
          </div>
        ))}
      </Card.Body>
    </Card>
  )
}

// One summary stat that doubles as a status filter toggle. Clicking filters the
// table to that status (or clears it back to "all" when re-clicked). Rendered
// for every status so a non-zero count can never be hidden from the summary.
function VpatStatCard({
  status,
  value,
  active,
  onClick,
}: {
  status: VpatConformance
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
        "rounded-box border p-4 text-start transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-base-300 bg-base-100 hover:border-primary/40",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-base-content/70">
        <span
          className={cx(
            "size-2 rounded-full",
            TONE_DOT_CLASS[VPAT_TONE[status]],
          )}
          aria-hidden="true"
        />
        {t(`accessibility.vpat.status.${status}`)}
      </span>
      <span className="mt-1 block text-2xl font-bold">{value}</span>
    </button>
  )
}

function VpatSection() {
  const { t } = useTranslation()
  const [vpat, setVpat] = useState<Vpat | null>(null)
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState<VpatFilter>("all")
  const [sort, setSort] = useState<VpatSort>("criterion")

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

  const visibleCriteria = useMemo(() => {
    if (!vpat) return []
    const filtered =
      filter === "all"
        ? vpat.criteria
        : vpat.criteria.filter((c) => c.status === filter)
    if (sort === "status") {
      return [...filtered].sort(
        (a, b) => STATUS_SORT_WEIGHT[a.status] - STATUS_SORT_WEIGHT[b.status],
      )
    }
    return filtered
  }, [vpat, filter, sort])

  const toggleFilter = (next: VpatConformance) =>
    setFilter((cur) => (cur === next ? "all" : next))

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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {VPAT_STATUS_ORDER.map((status) => (
              <VpatStatCard
                key={status}
                status={status}
                value={vpat.summary.byStatus[status]}
                active={filter === status}
                onClick={() => toggleFilter(status)}
              />
            ))}
          </div>

          <Alert tone="info" className="items-start text-sm">
            <Info aria-hidden="true" className="size-4 shrink-0" />
            <span>{t("accessibility.vpat.notEvaluatedNote")}</span>
          </Alert>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-base-content/70">
              {t("accessibility.vpat.generated", {
                generated: vpat.generated,
              })}
            </div>
            <div className="flex items-center gap-2">
              {filter !== "all" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFilter("all")}
                >
                  {t("accessibility.vpat.clearFilter")}
                </Button>
              )}
              <label className="flex items-center gap-2 text-sm text-base-content/70">
                {t("accessibility.vpat.sortBy")}
                <Select
                  selectSize="sm"
                  className="w-auto"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as VpatSort)}
                >
                  <option value="criterion">
                    {t("accessibility.vpat.sort.criterion")}
                  </option>
                  <option value="status">
                    {t("accessibility.vpat.sort.status")}
                  </option>
                </Select>
              </label>
            </div>
          </div>

          <VpatConformanceTable criteria={visibleCriteria} />
        </>
      )}
    </section>
  )
}

function ContrastSection() {
  const { t } = useTranslation()
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
    <section className="flex flex-col gap-6" aria-labelledby="contrast-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id="contrast-heading"
            className="text-xl font-bold tracking-tight"
          >
            {t("accessibility.title")}
          </h2>
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard
              label={t("accessibility.stat.pairs")}
              value={audit.summary.total}
            />
            <StatCard
              label={t("accessibility.stat.pass")}
              value={audit.summary.total - audit.summary.failures}
              outOf={audit.summary.total}
            />
            <StatCard
              label={t("accessibility.stat.withinMargin")}
              value={audit.summary.marginMisses}
            />
          </div>

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
    </section>
  )
}

type PanelKey = "contrast" | "vpat"

export default function AccessibilityPage() {
  const { t } = useTranslation()
  useDocumentTitle(t("accessibility.pageTitle"))
  const [panel, setPanel] = useState<PanelKey>("contrast")

  const tabs: { key: PanelKey; label: string }[] = [
    { key: "contrast", label: t("accessibility.tab.contrast") },
    { key: "vpat", label: t("accessibility.tab.vpat") },
  ]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6 2xl:max-w-7xl 2xl:px-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("accessibility.pageTitle")}
        </h1>
        <div className="mt-1 text-sm text-base-content/70">
          {t("accessibility.pageSubtitle")}
        </div>
      </div>

      <div role="tablist" className="tabs-boxed tabs w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === panel}
            className={`tab ${tab.key === panel ? "tab-active" : ""}`}
            onClick={() => setPanel(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {panel === "contrast" ? <ContrastSection /> : <VpatSection />}
    </div>
  )
}
