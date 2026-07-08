// Last-observed, non-sensitive app context for the "Copy diagnostics" snapshot:
// the granted OAuth scopes and HTTP status from the most recent GitHub response,
// plus the org the user is currently working in. In-memory only — this is a
// live-session convenience, not state worth persisting, and keeping it off disk
// keeps the org name (weakly identifying) out of localStorage.

export type ObservedContext = {
  // X-OAuth-Scopes from the latest response; null when absent (a fine-grained
  // PAT sends no such header — "unknown", not "no scopes").
  scopes: string | null
  status: number | null
  org: string | null
}

const context: ObservedContext = { scopes: null, status: null, org: null }

// Record the latest per-response signal (see GitHubProvider.onResponse).
export function observeResponse(signal: {
  status: number
  scopes: string | null
}): void {
  context.status = signal.status
  context.scopes = signal.scopes
}

// Record the org the user is currently viewing, so a snapshot taken from the
// About dialog can name it without threading org through every caller.
export function observeOrg(org: string | null): void {
  context.org = org
}

export function readObservedContext(): ObservedContext {
  return { ...context }
}

export function clearObservedContext(): void {
  context.scopes = null
  context.status = null
  context.org = null
}
