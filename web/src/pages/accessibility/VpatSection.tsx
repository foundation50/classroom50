import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpDown, CircleDashed, ListFilter } from "lucide-react"

import { Alert, Badge, Button, Card, Toolbar, cx } from "@/components/ui"
import {
  CONFORMANCE_TONE,
  hasGenericRemark,
  PRINCIPLE_ORDER,
  type ConformanceLevel,
  type Criterion,
  type WcagPrinciple,
} from "@/util/a11y/vpatModel"

import {
  TONE_DOT_CLASS,
  VPAT_STATUS_ORDER,
  tabClass,
  useVpatReport,
} from "./data"

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

export function VpatSection() {
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
              icon={<ListFilter aria-hidden="true" className="size-4" />}
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
                icon={<ArrowUpDown aria-hidden="true" className="size-4" />}
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
