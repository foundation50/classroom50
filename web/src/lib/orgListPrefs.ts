// Home-page org-list display preferences, persisted per browser so a returning
// user keeps their chosen view/sort. Built on the shared createListPrefs factory.

import { createListPrefs } from "@/lib/listPrefs"

export type OrgViewMode = "grid" | "list"
export type OrgSortKey = "name-asc" | "last-modified" | "status"

const prefs = createListPrefs<OrgViewMode, OrgSortKey>({
  viewKey: "orgs_view_mode",
  sortKey: "orgs_sort_key",
  viewValues: ["grid", "list"],
  sortValues: ["name-asc", "last-modified", "status"],
  defaultView: "grid",
  defaultSort: "name-asc",
  // Honor the persisted sort on load EXCEPT "last-modified": restoring it would
  // silently re-arm the per-org pushed_at fan-out on every visit, breaking the
  // home page's no-fan-out-by-default contract. The preference is still saved
  // (sticky within a session); load falls back to the name sort until re-picked.
  sanitizeSortOnLoad: (sort, defaultSort) =>
    sort === "last-modified" ? defaultSort : sort,
})

export const getStoredViewMode = prefs.getStoredViewMode
export const persistViewMode = prefs.persistViewMode
export const getStoredSortKey = prefs.getStoredSortKey
export const persistSortKey = prefs.persistSortKey
