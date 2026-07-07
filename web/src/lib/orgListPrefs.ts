// Home-page org-list display preferences, persisted per browser so a returning
// user keeps their chosen view/sort. Kept out of React Query — this is UI state,
// not server data.

export type OrgViewMode = "grid" | "list"
export type OrgSortKey = "name-asc" | "last-modified" | "status"

const VIEW_KEY = "orgs_view_mode"
const SORT_KEY = "orgs_sort_key"

const DEFAULT_VIEW: OrgViewMode = "grid"
const DEFAULT_SORT: OrgSortKey = "name-asc"

const VIEW_VALUES: OrgViewMode[] = ["grid", "list"]
const SORT_VALUES: OrgSortKey[] = ["name-asc", "last-modified", "status"]

function canUseStorage() {
  return typeof window !== "undefined"
}

export function getStoredViewMode(): OrgViewMode {
  if (!canUseStorage()) return DEFAULT_VIEW
  const raw = localStorage.getItem(VIEW_KEY)
  return VIEW_VALUES.includes(raw as OrgViewMode)
    ? (raw as OrgViewMode)
    : DEFAULT_VIEW
}

export function persistViewMode(mode: OrgViewMode) {
  if (!canUseStorage()) return
  localStorage.setItem(VIEW_KEY, mode)
}

// The persisted sort is honored on load EXCEPT "last-modified": restoring it
// would silently re-arm the per-org pushed_at fan-out on every visit, breaking
// the home page's no-fan-out-by-default contract. The preference is still
// saved (so re-selecting feels sticky within a session), but load falls back to
// the name sort until the user picks last-modified again.
export function getStoredSortKey(): OrgSortKey {
  if (!canUseStorage()) return DEFAULT_SORT
  const raw = localStorage.getItem(SORT_KEY)
  const parsed = SORT_VALUES.includes(raw as OrgSortKey)
    ? (raw as OrgSortKey)
    : DEFAULT_SORT
  return parsed === "last-modified" ? DEFAULT_SORT : parsed
}

export function persistSortKey(key: OrgSortKey) {
  if (!canUseStorage()) return
  localStorage.setItem(SORT_KEY, key)
}
