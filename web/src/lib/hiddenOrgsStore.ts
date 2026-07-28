// Per-browser set of org logins the user has hidden from the home page. A
// display preference, not server data, so it lives in localStorage rather than
// React Query — mirroring src/lib/listPrefs.ts and src/orgPolicy/unresolvedStore.ts.
// Keyed by org login (what search/sort/routing already key on), stored as a
// JSON string array under the classroom50: namespace.

import { localStorageOrNull } from "@/lib/webStorage"

export const HIDDEN_ORGS_STORAGE_KEY = "classroom50:hidden-orgs"

// Read the persisted hidden logins. Tolerates missing or corrupt JSON by
// returning an empty set — a bad value must never throw and lock the home page.
export function readHiddenOrgs(): Set<string> {
  const ls = localStorageOrNull()
  if (ls === null) return new Set()
  const raw = ls.getItem(HIDDEN_ORGS_STORAGE_KEY)
  if (raw === null) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [],
    )
  } catch {
    return new Set()
  }
}

export function persistHiddenOrgs(logins: Set<string>): void {
  localStorageOrNull()?.setItem(
    HIDDEN_ORGS_STORAGE_KEY,
    JSON.stringify([...logins]),
  )
}
