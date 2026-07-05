// Pure selection logic for a member list's multi-select, extracted so the
// tricky invariants (select-all targets only filtered + selectable rows; the
// non-selectable row — e.g. the signed-in owner/self — is never selectable; a
// selection persists across filtering) are unit-testable without rendering.
//
// Generic over any row carrying a stable `key`, so both the Org Members list
// (OrgMemberRow) and the classroom roster (TeamRosterRow) share it. The logic
// only reads `.key`; the caller supplies the `selectable` predicate.
type Keyed = { key: string }

// The rows in the current filtered view that MAY be selected — everything the
// `selectable` predicate (typically "not the signed-in self") allows.
export function selectableRows<T extends Keyed>(
  filtered: T[],
  selectable: (row: T) => boolean,
): T[] {
  return filtered.filter(selectable)
}

// Header-checkbox state over the filtered+selectable set:
//  - allSelected: every selectable-filtered row is selected (and there's >=1).
//  - someSelected: at least one is (drives the indeterminate box).
export function selectAllState<T extends Keyed>(
  selectableFiltered: T[],
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
export function toggleSelectAll<T extends Keyed>(
  selectableFiltered: T[],
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
export function resolveSelectedRows<T extends Keyed>(
  rows: T[],
  selectedKeys: ReadonlySet<string>,
  selectable: (row: T) => boolean,
): T[] {
  return rows.filter((row) => selectedKeys.has(row.key) && selectable(row))
}
