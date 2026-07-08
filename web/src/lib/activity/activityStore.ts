// The session Activity store: a module-level, sessionStorage-backed, TTL-bounded
// record of MEANINGFUL activity (failed mutations, shown error toasts, uncaught
// errors, dispatched actions). Module-level (not React state) because the feeds
// run outside React — a global MutationCache.onError, window error handlers, and
// the notification provider — so they need a plain function to call. React reads
// it via useSyncExternalStore in ActivityProvider.
//
// Ephemeral by design (per the app's no-backend rule): sessionStorage is tab-
// scoped and we drop entries past a TTL, so this never becomes cross-session,
// cross-user, or PII-at-rest beyond the current tab.
//
// PRIVACY CONTRACT (carried over from the diagnostics buffer): an entry is an
// ALLOW-LISTED projection. We never store the raw GitHub response body or the
// raw X-GitHub-SSO header (it carries an authorization_request token) — only the
// derived `ssoRequired` / `scopeGap` booleans, the request-id, status, endpoint,
// name, and message.

import { GitHubAPIError } from "@/hooks/github/errors"

export type ActivityKind = "error" | "action"

export type ActivityEntry = {
  id: string
  // Present when the activity is org-scoped, so the org page can filter.
  org?: string
  kind: ActivityKind
  // Human-readable summary. For errors this is the error message.
  label: string
  // GitHub-specific fields, present only for a GitHubAPIError-derived entry.
  status?: number
  endpoint?: string
  requestId?: string | null
  ssoRequired?: boolean
  scopeGap?: boolean
  // Epoch ms; drives TTL eviction and display order.
  at: number
}

const STORAGE_KEY = "cl50:activity"
// Bounded window so a long-lived tab doesn't accumulate stale noise. Matches the
// spirit of ActionActivityProvider's op TTL, widened since this is a browse view.
const TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 50
// Collapse a burst of the same failure (e.g. a mutation that also toasts) into
// one entry when they arrive within this window carrying the same dedup key.
const DEDUP_WINDOW_MS = 5000

let seq = 0
const nextId = () => `act-${Date.now()}-${++seq}`

type PendingDedup = { key: string; at: number; id: string }
let recentByKey: PendingDedup[] = []

let entries: ActivityEntry[] = load()
const listeners = new Set<() => void>()

function canUseStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.sessionStorage !== "undefined"
  )
}

function load(): ActivityEntry[] {
  if (!canUseStorage()) return []
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - TTL_MS
    return (parsed as ActivityEntry[]).filter(
      (e) => typeof e?.at === "number" && e.at >= cutoff,
    )
  } catch {
    return []
  }
}

function persist(): void {
  if (!canUseStorage()) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Best-effort; in-memory tracking still works this mount.
  }
}

function emit(): void {
  for (const l of listeners) l()
}

// Project any thrown value into an allow-listed entry. Never reads error.body or
// error.ssoHeader — see the file header's privacy contract.
export function toActivityEntry(
  error: unknown,
  context?: { org?: string; label?: string },
): ActivityEntry {
  const base = {
    id: nextId(),
    org: context?.org,
    kind: "error" as const,
    at: Date.now(),
  }
  if (error instanceof GitHubAPIError) {
    return {
      ...base,
      org: context?.org ?? orgFromApiUrl(error.url),
      label: context?.label ?? error.message,
      status: error.status,
      endpoint: error.url,
      requestId: error.requestId,
      ssoRequired: error.isSsoRequired,
      scopeGap: error.isScopeGap,
    }
  }
  if (error instanceof Error) {
    return { ...base, label: context?.label ?? error.message }
  }
  return { ...base, label: context?.label ?? String(error) }
}

function pushEntry(entry: ActivityEntry, dedupKey?: string): void {
  const now = entry.at
  const cutoff = now - TTL_MS
  recentByKey = recentByKey.filter((r) => r.at >= now - DEDUP_WINDOW_MS)

  if (dedupKey) {
    const dup = recentByKey.find((r) => r.key === dedupKey)
    if (dup) {
      // Replace the earlier entry in place (idempotent re-record of one op).
      entries = entries.map((e) =>
        e.id === dup.id ? { ...entry, id: e.id } : e,
      )
      dup.at = now
      persist()
      emit()
      return
    }
    recentByKey.push({ key: dedupKey, at: now, id: entry.id })
  }

  entries = [...entries.filter((e) => e.at >= cutoff), entry]
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES)
  }
  persist()
  emit()
}

// When the last "structural" error (MutationCache/global handler) was recorded.
// A follow-up error toast for the SAME failure fires microseconds later at its
// mutation's onError call site; we suppress that toast record so one failure is
// listed once. Structural capture is preferred because it carries the
// GitHubAPIError fields (status/requestId/scopeGap); the toast is a translated
// summary. Non-mutation error toasts (no preceding structural error in the
// window) still record — preserving the "capture what the user saw" path.
let lastStructuralErrorAt = 0

// Record a caught/thrown error as an error-kind activity entry. Used by the
// MutationCache and the global window handlers (the "structural" sources).
export function recordError(
  error: unknown,
  context?: { org?: string; label?: string; dedupKey?: string },
): void {
  lastStructuralErrorAt = Date.now()
  pushEntry(toActivityEntry(error, context), context?.dedupKey)
}

// Record a user-facing error toast, unless it's the follow-up toast of a
// structural error just recorded (same failure). See lastStructuralErrorAt.
export function recordErrorToast(message: string): void {
  if (Date.now() - lastStructuralErrorAt <= DEDUP_WINDOW_MS) return
  pushEntry(toActivityEntry(new Error(message)))
}

// Record a non-error, meaningful action (e.g. a dispatched workflow).
export function recordAction(label: string, context?: { org?: string }): void {
  pushEntry({
    id: nextId(),
    org: context?.org,
    kind: "action",
    label,
    at: Date.now(),
  })
}

// Most-recent-last copy of all live entries.
export function readActivity(): ActivityEntry[] {
  const cutoff = Date.now() - TTL_MS
  return entries.filter((e) => e.at >= cutoff)
}

// Entries for one org, most-recent-last.
export function activityForOrg(org: string | undefined): ActivityEntry[] {
  if (!org) return []
  return readActivity().filter((e) => e.org === org)
}

export function clearActivity(): void {
  entries = []
  recentByKey = []
  lastStructuralErrorAt = 0
  persist()
  emit()
}

// Best-effort org extraction from a GitHub API URL, so a failed mutation can be
// attributed to the org page without every call site threading org through.
// Matches /orgs/{org}/... and /repos/{org}/... — the two org-owned shapes.
export function orgFromApiUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m = url.match(/\/(?:orgs|repos)\/([^/]+)/)
  return m ? m[1] : undefined
}

// useSyncExternalStore plumbing for the provider.
export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getActivitySnapshot(): ActivityEntry[] {
  return entries
}
