import { useCallback, useMemo, useState } from "react"

import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  shouldWarnNoneSelectable,
  toggleSelectAll,
  type KeyOf,
} from "@/util/rowSelection"
import { useRangeSelection, type RangeSelection } from "./useRangeSelection"

// Why the header toggle did nothing, so the page can explain it (the roster
// shows a notice when the view is filtered to rows the bar can't act on).
export type SelectAllOutcome = "toggled" | "none-selectable" | "empty"

export interface UseRowSelectionArgs<T> {
  // The full set. Selection resolves against this, so a selected row the
  // search hides is still acted on.
  rows: T[]
  // The current filtered view: the header checkbox's target.
  filtered: T[]
  // The ACTUAL rendered order when it differs from `filtered` (a grouped view),
  // so a shift-range spans what the user sees.
  rendered?: T[]
  // Stable (useCallback) when it closes over changing state such as the viewer;
  // the memos below key on it.
  isSelectable: (row: T) => boolean
  keyOf: KeyOf<T>
  // Drop keys whose rows left `rows`, during render. A recreated key would
  // otherwise come back pre-ticked. Off by default: the roster keeps a selected
  // row through an optimistic removal until its reconcile lands.
  pruneMissing?: boolean
}

export interface RowSelection<T> extends RangeSelection {
  selectedKeys: ReadonlySet<string>
  // Rows backing the selection across the full set, non-selectable excluded,
  // deduped by key (a hand-edited file can repeat one).
  selectedRows: T[]
  selectableFiltered: T[]
  allSelected: boolean
  someSelected: boolean
  toggleSelectAll: () => SelectAllOutcome
  deselect: (key: string) => void
  clear: () => void
}

// The multi-select every table composes: keyed selection state, the header
// checkbox over the filtered+selectable view, shift-click ranges, and the
// resolved rows the bulk bar acts on. The pure rules live in util/rowSelection;
// this wires them to state once so the three tables can't drift.
export function useRowSelection<T>({
  rows,
  filtered,
  rendered,
  isSelectable,
  keyOf,
  pruneMissing = false,
}: UseRowSelectionArgs<T>): RowSelection<T> {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const selectedRows = useMemo(() => {
    const seen = new Set<string>()
    return resolveSelectedRows(rows, selectedKeys, isSelectable, keyOf).filter(
      (row) => {
        const key = keyOf(row)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
    )
  }, [rows, selectedKeys, isSelectable, keyOf])

  const selectableFiltered = useMemo(
    () => selectableRows(filtered, isSelectable),
    [filtered, isSelectable],
  )

  const { allSelected, someSelected } = selectAllState(
    selectableFiltered,
    selectedKeys,
    keyOf,
  )

  const { handleToggleRow, handleRowCheckboxClick } = useRangeSelection(
    rendered ?? filtered,
    isSelectable,
    setSelectedKeys,
    keyOf,
  )

  const toggleSelectAllRows = useCallback((): SelectAllOutcome => {
    if (shouldWarnNoneSelectable(filtered.length, selectableFiltered.length)) {
      return "none-selectable"
    }
    if (selectableFiltered.length === 0) return "empty"
    setSelectedKeys((prev) => toggleSelectAll(selectableFiltered, prev, keyOf))
    return "toggled"
  }, [filtered.length, selectableFiltered, keyOf])

  const deselect = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  const clear = useCallback(() => setSelectedKeys(new Set()), [])

  // `liveKeys` is a subset of `selectedKeys`, so sizes suffice. Setting state
  // during render (rather than in an effect) avoids a frame with a stale count.
  if (pruneMissing) {
    const liveKeys = new Set(selectedRows.map(keyOf))
    if (liveKeys.size !== selectedKeys.size) setSelectedKeys(liveKeys)
  }

  return {
    selectedKeys,
    selectedRows,
    selectableFiltered,
    allSelected,
    someSelected,
    toggleSelectAll: toggleSelectAllRows,
    deselect,
    clear,
    handleToggleRow,
    handleRowCheckboxClick,
  }
}
