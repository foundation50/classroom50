// Per-org, per-browser record of audit "Fix it" attempts that didn't complete,
// so the pane doesn't re-offer a fix that already failed after a reload or
// re-check. UI-derived state, not server data, so it lives in localStorage
// rather than React Query — mirroring src/lib/listPrefs.ts. Two kinds of
// outcome are stored: unresolved orgDefaults `fields` (member-default writes
// that didn't stick on read-back) and unresolved concern `concerns` (a
// branchProtection/rulesets repair that returned a warning). Only non-transient
// outcomes are persisted; the caller filters out transient failures.

const KEY_PREFIX = "c50:audit:unresolved:v1:"

function canUseStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  )
}

function store(): Storage | null {
  return canUseStorage() ? window.localStorage : null
}

function keyFor(org: string): string {
  return `${KEY_PREFIX}${org}`
}

export type UnresolvedRecord = {
  fields: Set<string>
  concerns: Set<string>
}

type StoredShape = {
  fields: string[]
  concerns: string[]
}

function empty(): UnresolvedRecord {
  return { fields: new Set(), concerns: new Set() }
}

// Read the persisted outcome for an org. Tolerates missing or corrupt JSON by
// returning empty sets — a bad value must never throw and lock the pane.
export function readUnresolved(org: string): UnresolvedRecord {
  const ls = store()
  if (ls === null) return empty()
  const raw = ls.getItem(keyFor(org))
  if (raw === null) return empty()
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape>
    return {
      fields: new Set(Array.isArray(parsed.fields) ? parsed.fields : []),
      concerns: new Set(Array.isArray(parsed.concerns) ? parsed.concerns : []),
    }
  } catch {
    return empty()
  }
}

// Union the given fields/concerns into the org's stored record and write it
// back. Merging (not replacing) means a later Fix-it on a different concern
// doesn't drop an earlier unresolved outcome.
export function mergeUnresolved(
  org: string,
  add: { fields?: Iterable<string>; concerns?: Iterable<string> },
): void {
  const ls = store()
  if (ls === null) return
  const current = readUnresolved(org)
  for (const f of add.fields ?? []) current.fields.add(f)
  for (const c of add.concerns ?? []) current.concerns.add(c)
  const stored: StoredShape = {
    fields: [...current.fields],
    concerns: [...current.concerns],
  }
  ls.setItem(keyFor(org), JSON.stringify(stored))
}

export function clearUnresolved(org: string): void {
  const ls = store()
  if (ls === null) return
  ls.removeItem(keyFor(org))
}
