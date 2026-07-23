// Per-browser set of org logins the user has hidden from the home page. A
// display preference, not server data, so it lives in localStorage rather than
// React Query — mirroring src/lib/listPrefs.ts and src/orgPolicy/unresolvedStore.ts.
// Keyed by org login (what search/sort/routing already key on), stored as a
// JSON string array under the classroom50: namespace.

export const HIDDEN_ORGS_STORAGE_KEY = "classroom50:hidden-orgs"

function canUseStorage(): boolean {
  // `window` can exist while `localStorage` is absent or throws (SSR/test DOMs,
  // sandboxed iframes, blocked cookies). Probe the real API so a read/write
  // never throws and hidden state degrades to "nothing hidden".
  try {
    return typeof window !== "undefined" && window.localStorage != null
  } catch {
    return false
  }
}

// Read the persisted hidden logins. Tolerates missing or corrupt JSON by
// returning an empty set — a bad value must never throw and lock the home page.
export function readHiddenOrgs(): Set<string> {
  if (!canUseStorage()) return new Set()
  const raw = window.localStorage.getItem(HIDDEN_ORGS_STORAGE_KEY)
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
  if (!canUseStorage()) return
  window.localStorage.setItem(
    HIDDEN_ORGS_STORAGE_KEY,
    JSON.stringify([...logins]),
  )
}
