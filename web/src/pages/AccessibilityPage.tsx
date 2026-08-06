import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"
import { Info, CircleDashed, Download } from "lucide-react"

import { Alert, Badge, Button, Card, Modal, Toolbar, cx } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { DrawerShell } from "@/components/drawer"
import { sectionFromHash } from "@/util/a11y/accessibilitySections"
import type { BadgeTone } from "@/types/badgeTone"
import { CONFORMANCE_TONE, hasGenericRemark } from "@/util/a11y/vpatModel"
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
  assessed?: string
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
const VPAT_STATUS_ORDER: VpatConformance[] = [
  "supports",
  "partially",
  "doesNotSupport",
  "notApplicable",
  "notEvaluated",
]

const PRINCIPLE_ORDER = [
  "Perceivable",
  "Operable",
  "Understandable",
  "Robust",
] as const

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

type VpatFilter = VpatConformance | "all"
type VpatSort = "criterion" | "status"

const STATUS_SORT_WEIGHT: Record<VpatConformance, number> = {
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
  criteria: VpatCriterion[]
  generated: string
}) {
  const { t } = useTranslation()
  const [activePrinciple, setActivePrinciple] =
    useState<(typeof PRINCIPLE_ORDER)[number]>("Perceivable")

  // Counts per principle reflect the current search/filter so a tab shows how
  // many rows it holds (and an emptied tab reads 0 rather than looking broken).
  const countByPrinciple = useMemo(() => {
    const counts = {} as Record<(typeof PRINCIPLE_ORDER)[number], number>
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
  const [vpat, setVpat] = useState<Vpat | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState("")
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
  const toggleFilter = (status: VpatConformance) =>
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
                  onClick={() => setActiveTheme(th.theme)}
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

// The public accessibility statement (W3C best practice): commitment +
// conformance target, the current known limitations, and a feedback path. Prose
// is i18n-backed; the discussion link is the feedback route (issue #493).
function StatementSection() {
  const { t } = useTranslation()
  return (
    <Card>
      <Card.Body className="prose prose-sm max-w-none">
        <h2>{t("accessibility.statement.heading")}</h2>
        <p>{t("accessibility.statement.intro")}</p>
        <h3>{t("accessibility.statement.targetHeading")}</h3>
        <p>{t("accessibility.statement.target")}</p>
        <h3>{t("accessibility.statement.limitationsHeading")}</h3>
        <p>{t("accessibility.statement.limitations")}</p>
        <h3>{t("accessibility.statement.feedbackHeading")}</h3>
        <p>
          {t("accessibility.statement.feedback")}{" "}
          <a
            href="https://github.com/foundation50/classroom50/discussions/493"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("accessibility.statement.feedbackLink")}
          </a>
          .
        </p>
      </Card.Body>
    </Card>
  )
}

// One downloadable report row: title + description + a download button. The
// files are build-emitted into dist/ and served at their root path.
function DownloadRow({
  href,
  title,
  description,
}: {
  href: string
  title: string
  description: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <p className="text-sm text-base-content/70">{description}</p>
      </div>
      <Button
        as="a"
        href={href}
        download
        variant="outline"
        size="sm"
        className="shrink-0"
      >
        <Download aria-hidden="true" className="size-4" />
        {t("accessibility.downloads.action")}
      </Button>
    </div>
  )
}

// A single place to find and download every report, so the report tabs stay
// focused on reading rather than repeating download controls.
function DownloadsSection() {
  const { t } = useTranslation()
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
          />
          <DownloadRow
            href="/VPAT-INT.md"
            title={t("accessibility.downloads.vpatIntTitle")}
            description={t("accessibility.downloads.vpatIntDesc")}
          />
          <DownloadRow
            href="/CONTRAST-AUDIT.md"
            title={t("accessibility.downloads.contrastTitle")}
            description={t("accessibility.downloads.contrastDesc")}
          />
        </Card.Body>
      </Card>
    </section>
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

        {section === "conformance" ? (
          <VpatSection />
        ) : section === "color-contrast" ? (
          <ContrastSection />
        ) : section === "statement" ? (
          <StatementSection />
        ) : (
          <DownloadsSection />
        )}
      </PageShell>
    </DrawerShell>
  )
}
