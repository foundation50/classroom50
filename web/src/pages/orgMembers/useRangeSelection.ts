import { useRef } from "react"

import { selectRange, toggleRow } from "@/pages/orgMembers/selection"

type Keyed = { key: string }

// Checkbox multi-select wiring shared by OrgMembersPage and EnrolledStudents.
// Owns the shift-click bookkeeping so the two tables (and the regression test)
// exercise one implementation instead of hand-copied handlers that can drift.
//
// The subtle bit: a shift-click's onClick fills the range, but the checkbox's
// onChange still fires and would toggle the just-selected endpoint back off
// (preventDefault() in onClick doesn't reliably suppress React's onChange). We
// flag the shift-handled event so onChange swallows that follow-up toggle.
export interface RangeSelection {
  // Checkbox onChange: plain toggle + anchor update, unless a shift-click on the
  // same event already handled it as a range.
  handleToggleRow: (key: string) => void
  // Checkbox onClick: fills the range from the anchor on a shift-click.
  handleRowCheckboxClick: (
    e: React.MouseEvent<HTMLInputElement>,
    key: string,
  ) => void
}

export function useRangeSelection<T extends Keyed>(
  // The ACTUAL rendered order, so a shift-range spans what the user sees (e.g.
  // a group-by-section view, not the flat filtered list).
  order: T[],
  selectable: (row: T) => boolean,
  setSelectedKeys: (updater: (prev: Set<string>) => Set<string>) => void,
): RangeSelection {
  // Last plain-clicked checkbox; a shift-click fills the range from here.
  const rangeAnchorKey = useRef<string | null>(null)
  // Set by a shift-click's onClick so the follow-up onChange skips its toggle.
  const rangeHandledRef = useRef(false)

  const handleToggleRow = (key: string) => {
    if (rangeHandledRef.current) {
      rangeHandledRef.current = false
      return
    }
    setSelectedKeys((prev) => toggleRow(prev, key))
    rangeAnchorKey.current = key
  }

  const handleRowCheckboxClick = (
    e: React.MouseEvent<HTMLInputElement>,
    key: string,
  ) => {
    const anchor = rangeAnchorKey.current
    if (e.shiftKey && anchor && anchor !== key) {
      rangeHandledRef.current = true
      setSelectedKeys((prev) =>
        selectRange(order, anchor, key, prev, selectable),
      )
      rangeAnchorKey.current = key
    }
  }

  return { handleToggleRow, handleRowCheckboxClick }
}
