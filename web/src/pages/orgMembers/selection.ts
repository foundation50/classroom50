import type { OrgMemberRow } from "@/util/orgMembers"

// Pure selection logic for the Members page's multi-select, extracted so the
// tricky invariants (select-all targets only filtered + selectable rows; the
// signed-in owner is never selectable; a selection persists across filtering)
// are unit-testable without rendering.

// The rows in the current filtered view that MAY be selected — everything the
// `selectable` predicate (typically "not the signed-in self") allows.
export function selectableRows(
  filtered: OrgMemberRow[],
  selectable: (row: OrgMemberRow) => boolean,
): OrgMemberRow[] {
  return filtered.filter(selectable)
}

// Header-checkbox state over the filtered+selectable set:
//  - allSelected: every selectable-filtered row is selected (and there's >=1).
//  - someSelected: at least one is (drives the indeterminate box).
export function selectAllState(
  selectableFiltered: OrgMemberRow[],
  selectedKeys: ReadonlySet<string>,
): { allSelected: boolean; someSelected: boolean } {
  const allSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((row) => selectedKeys.has(row.key))
  const someSelected = selectableFiltered.some((row) =>
    selectedKeys.has(row.key),
  )
  return { allSelected, someSelected }
}

// Next selection after toggling the header checkbox: if all selectable-filtered
// rows are already selected, deselect exactly them; otherwise select them —
// leaving any selected rows OUTSIDE the current filter untouched.
export function toggleSelectAll(
  selectableFiltered: OrgMemberRow[],
  selectedKeys: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selectedKeys)
  const { allSelected } = selectAllState(selectableFiltered, selectedKeys)
  for (const row of selectableFiltered) {
    if (allSelected) next.delete(row.key)
    else next.add(row.key)
  }
  return next
}

// Toggle one row's membership in the selection.
export function toggleRow(
  selectedKeys: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selectedKeys)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

// Rows backing the current selection across the FULL set (a selected row hidden
// by search is still acted on), with non-selectable rows (self) excluded so a
// stale selection can't target them.
export function resolveSelectedRows(
  rows: OrgMemberRow[],
  selectedKeys: ReadonlySet<string>,
  selectable: (row: OrgMemberRow) => boolean,
): OrgMemberRow[] {
  return rows.filter((row) => selectedKeys.has(row.key) && selectable(row))
}
