import { useTranslation } from "react-i18next"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cx } from "./cx"
import { rtlFlip } from "./icons"
import { Select } from "./Select"

// A conventional table pager: a "Show N entries" size selector, a "N to M of T"
// range label, and Prev / numbered / Next controls. Pure presentation — the
// caller owns page + pageSize state and the slicing (see paginateDisplayItems /
// pageBounds in the submissions dashboard). Page indices are 0-based on the
// wire; the labels render them 1-based.
export type TablePaginationProps = {
  page: number
  pageCount: number
  pageSize: number
  pageSizeOptions: readonly number[]
  // 1-based inclusive range + total, for the range label.
  from: number
  to: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  // Compact page list with `null` for an ellipsis gap (see paginationRange).
  pages: (number | null)[]
  className?: string
}

export function TablePagination({
  page,
  pageCount,
  pageSize,
  pageSizeOptions,
  from,
  to,
  total,
  onPageChange,
  onPageSizeChange,
  pages,
  className,
}: TablePaginationProps) {
  const { t } = useTranslation()

  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 text-sm",
        className,
      )}
    >
      <label className="inline-flex items-center gap-2 text-base-content/70">
        {t("common.pagination.show")}
        <Select
          selectSize="xs"
          className="w-auto"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label={t("common.pagination.showAria")}
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </Select>
        {t("common.pagination.entries")}
      </label>

      <span className="text-base-content/70" role="status" aria-live="polite">
        {t("common.pagination.range", { from, to, total })}
      </span>

      <nav className="join" aria-label={t("common.pagination.navAria")}>
        <button
          type="button"
          className="btn btn-sm join-item"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
          aria-label={t("common.pagination.previous")}
        >
          <ChevronLeft aria-hidden="true" className={cx("size-4", rtlFlip)} />
        </button>
        {pages.map((p, i) =>
          p === null ? (
            <button
              key={`gap-${i}`}
              type="button"
              className="btn btn-sm join-item btn-disabled"
              tabIndex={-1}
              aria-hidden="true"
            >
              …
            </button>
          ) : (
            <button
              key={p}
              type="button"
              className={cx("btn btn-sm join-item", p === page && "btn-active")}
              aria-current={p === page ? "page" : undefined}
              onClick={() => onPageChange(p)}
            >
              {p + 1}
            </button>
          ),
        )}
        <button
          type="button"
          className="btn btn-sm join-item"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
          aria-label={t("common.pagination.next")}
        >
          <ChevronRight aria-hidden="true" className={cx("size-4", rtlFlip)} />
        </button>
      </nav>
    </div>
  )
}

export default TablePagination
