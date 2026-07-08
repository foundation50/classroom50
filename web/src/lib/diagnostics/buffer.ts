// A small in-memory ring of the most recent errors, feeding the "Copy
// diagnostics" snapshot. In-memory only (never persisted): an error's endpoint
// and message can carry incidental PII (usernames, org names), so it must die
// with the tab rather than become a PII-at-rest surface.
//
// The privacy contract lives here: recordError extracts an ALLOW-LISTED set of
// non-sensitive fields and never keeps the raw response body or the raw
// X-GitHub-SSO header (which carries an authorization_request token). Only the
// derived `ssoRequired` / `scopeGap` booleans and the request-id are kept.

import { GitHubAPIError } from "@/hooks/github/errors"

const MAX_ENTRIES = 10

export type DiagnosticEntry = {
  timestamp: string
  name: string
  message: string
  // GitHub-specific fields, present only for a GitHubAPIError.
  status?: number
  endpoint?: string
  requestId?: string | null
  ssoRequired?: boolean
  scopeGap?: boolean
}

const entries: DiagnosticEntry[] = []

// Derive an allow-listed entry from any thrown value. For a GitHubAPIError we
// keep the diagnostic-useful fields; for anything else just name + message.
// Never reads error.body or error.ssoHeader — see the file header.
export function recordError(error: unknown): void {
  const timestamp = new Date().toISOString()

  let entry: DiagnosticEntry
  if (error instanceof GitHubAPIError) {
    entry = {
      timestamp,
      name: error.name,
      message: error.message,
      status: error.status,
      endpoint: error.url,
      requestId: error.requestId,
      ssoRequired: error.isSsoRequired,
      scopeGap: error.isScopeGap,
    }
  } else if (error instanceof Error) {
    entry = { timestamp, name: error.name, message: error.message }
  } else {
    entry = { timestamp, name: "UnknownError", message: String(error) }
  }

  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
}

// Most-recent-last copy of the buffer. A copy so callers can't mutate the ring.
export function readRecentErrors(): DiagnosticEntry[] {
  return [...entries]
}

export function clearRecentErrors(): void {
  entries.length = 0
}
