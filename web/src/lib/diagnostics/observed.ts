// Last-observed, non-sensitive app context for the "Copy diagnostics" snapshot:
// the granted OAuth scopes and HTTP status from the most recent GitHub response.
// In-memory only — this is a live-session convenience, not state worth
// persisting. The org is NOT tracked here: every snapshot caller threads the
// route-scoped org explicitly, so an observed-org fallback would be dead code.

export type ObservedContext = {
  // X-OAuth-Scopes from the latest response; null when absent (a fine-grained
  // PAT sends no such header — "unknown", not "no scopes").
  scopes: string | null
  status: number | null
}

const context: ObservedContext = { scopes: null, status: null }

// Record the latest per-response signal (see GitHubProvider.onResponse).
export function observeResponse(signal: {
  status: number
  scopes: string | null
}): void {
  context.status = signal.status
  context.scopes = signal.scopes
}

export function readObservedContext(): ObservedContext {
  return { ...context }
}

export function clearObservedContext(): void {
  context.scopes = null
  context.status = null
}
