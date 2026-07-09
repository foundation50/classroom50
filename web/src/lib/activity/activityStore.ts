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
  // First app (non-node_modules, non-framework) frame of the error's stack, for
  // pinpointing an uncaught error's origin — e.g. "useGithubAuth.tsx:743". Kept
  // short (one frame) and app-origin only; still no raw body/token.
  source?: string
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
    // Quota/private-mode failure: drop the oldest half and retry once so a
    // burst degrades to the most-recent entries rather than dropping the write
    // wholesale. In-memory tracking still holds the full set this mount.
    try {
      const trimmed = entries.slice(Math.ceil(entries.length / 2))
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      // Still failing — best-effort; give up on persistence this write.
    }
  }
}

function emit(): void {
  for (const l of listeners) l()
}

// Extract up to the first few app-origin frames from an Error stack, each
// shortened to "file.tsx:line:col" and joined with " < " (innermost first).
// Skips node_modules and framework internals so the source points at our code,
// not React/router plumbing — and keeps a couple of caller frames so the
// throwing site AND the component that reached it are both visible. Returns
// undefined if the stack is absent or has no app frame.
export function sourceFromStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  const frames: string[] = []
  for (const line of stack.split("\n")) {
    // A stack frame referencing a bundled source. Skip framework/vendor frames.
    if (/node_modules|react-dom|react\/|scheduler/.test(line)) continue
    // Match the last path segment + line:col, e.g. ".../useGithubAuth.tsx:743:11".
    // Strip a Vite HMR "?t=..." cache-buster so the frame stays readable.
    const m = line.match(
      /([\w.-]+\.(?:tsx?|jsx?|mjs))(?:\?[^:]*)?:(\d+)(?::(\d+))?/,
    )
    if (m) {
      frames.push(m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`)
      if (frames.length >= 3) break
    }
  }
  return frames.length > 0 ? frames.join(" < ") : undefined
}

// Project any thrown value into an allow-listed entry. Never reads error.body or
// error.ssoHeader — see the file header's privacy contract.
export function toActivityEntry(
  error: unknown,
  context?: { org?: string; label?: string; source?: string },
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
    return {
      ...base,
      label: context?.label ?? error.message,
      // Prefer the error's own stack (sourcemapped to .tsx in dev); fall back to
      // the caller-supplied source (e.g. window.onerror's filename:lineno).
      source: sourceFromStack(error.stack) ?? context?.source,
    }
  }
  return {
    ...base,
    label: context?.label ?? String(error),
    source: context?.source,
  }
}

function pushEntry(entry: ActivityEntry, dedupKey?: string): void {
  const now = entry.at
  const cutoff = now - TTL_MS
  recentByKey = recentByKey.filter((r) => r.at >= now - DEDUP_WINDOW_MS)

  if (dedupKey) {
    const dup = recentByKey.find((r) => r.key === dedupKey)
    if (dup) {
      // Replace the earlier entry in place (idempotent re-record of one op).
      // If it was already evicted (TTL / MAX_ENTRIES) while its dedup record
      // still lives inside the window, `map` matches nothing — fall through to
      // append below rather than silently dropping the re-record.
      const replaced = entries.some((e) => e.id === dup.id)
      if (replaced) {
        entries = entries.map((e) =>
          e.id === dup.id ? { ...entry, id: e.id } : e,
        )
        dup.at = now
        persist()
        emit()
        return
      }
      recentByKey = recentByKey.filter((r) => r !== dup)
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

// Structural errors (a failed mutation) recorded within the dedup window, kept
// as {message, at} so a follow-up error toast can be matched to the SAME failure
// rather than any recent one. A single global timestamp would let one failure
// silence an unrelated toast fired seconds later; matching on the message (and
// only arming for structural sources that actually emit a paired toast) scopes
// suppression to the real duplicate. The toast shows a translated summary while
// the mutation records error.message, so the match is a containment check.
type RecentStructural = { message: string; at: number }
let recentStructural: RecentStructural[] = []

function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase()
}

// Record a caught/thrown error as an error-kind activity entry. Used by the
// MutationCache and the global window handlers (the "structural" sources). A
// dedupKey marks a source with a paired follow-up toast (the MutationCache),
// arming toast-suppression for this specific failure; a bare window handler
// (uncaught error / unhandled rejection) has no paired toast, so it does not arm
// the window and can't silence an unrelated toast.
export function recordError(
  error: unknown,
  context?: {
    org?: string
    label?: string
    dedupKey?: string
    source?: string
  },
): void {
  const entry = toActivityEntry(error, context)
  if (context?.dedupKey) {
    recentStructural = recentStructural.filter(
      (r) => r.at >= entry.at - DEDUP_WINDOW_MS,
    )
    recentStructural.push({
      message: normalizeForMatch(entry.label),
      at: entry.at,
    })
  }
  pushEntry(entry, context?.dedupKey)
}

// Record a user-facing error toast, unless it's the follow-up toast of the SAME
// structural error just recorded (a failed mutation shows a toast microseconds
// after MutationCache.onError). The toast message is a translated summary and
// the structural entry is the raw error.message, so match by containment either
// way. An unrelated toast — or one with no matching recent structural error —
// still records.
export function recordErrorToast(message: string): void {
  const now = Date.now()
  recentStructural = recentStructural.filter(
    (r) => r.at >= now - DEDUP_WINDOW_MS,
  )
  const norm = normalizeForMatch(message)
  const isFollowUp = recentStructural.some(
    (r) => r.message.includes(norm) || norm.includes(r.message),
  )
  if (isFollowUp) return
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
  recentStructural = []
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
