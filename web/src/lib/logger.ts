// The one sanctioned wrapper around `console` for the app. Everything else goes
// through here so leveled, timestamped, call-site-tagged, scoped output is
// centralised — and the `no-console` lint rule can forbid raw `console`
// everywhere but this file (see eslint.config.js).
//
// Design for a no-backend SPA: there is nowhere to ship logs, so "logging" is
// (a) developer-facing console output and (b) the session Activity store that
// backs the "Copy diagnostics" snapshot. This wrapper unifies (a) and lets a
// call opt into (b) via `{ record: true }`, so a single line both prints in dev
// and lands in the diagnostics a user can paste into a bug report — without
// double-recording the paths that already feed activity (MutationCache.onError,
// the window handlers), which stay untouched.
//
// PRIVACY: `error`/`warn` may reach the recorded Activity store, which is an
// allow-listed projection (see lib/activity/activityStore.ts). Never pass a raw
// GitHub response body or the X-GitHub-SSO header as the message or context —
// the same contract the store enforces.

import { recordError, sourceFromStack } from "@/lib/activity/activityStore"

export type LogLevel = "debug" | "info" | "warn" | "error"

// Ordered so a threshold comparison ("at least warn") is a numeric one.
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

// In a production build only warn/error print (matches the app's existing
// DEV-gating of verbose console output); dev prints everything. `import.meta`
// env is read once at module load — it's a compile-time constant under Vite.
const MIN_LEVEL: LogLevel = import.meta.env.DEV ? "debug" : "warn"

// Structured context attached to a line. Kept to primitives + the known
// activity fields so it stays greppable and never invites a raw object dump.
export type LogContext = {
  // Org this line pertains to — threaded into a recorded activity entry.
  org?: string
  // When true, an `error`/`warn` also records into the session Activity store
  // so it surfaces in the diagnostics snapshot. Off by default: most call sites
  // are dev-facing, and the mutation/window paths already record on their own.
  record?: boolean
  // Any other structured, non-sensitive fields to print alongside the message.
  [key: string]: unknown
}

// Drop this module's own frames from a stack so an origin resolves to the real
// caller, not logger.ts. Shared by callSite() and the record path so the two
// stay in lockstep.
function stripLoggerFrames(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => !/logger\.(?:ts|js)/.test(line))
    .join("\n")
}

// First app frame of the CURRENT call, so a line prints "where it came from"
// even when no Error is passed. Reuses the activity store's frame extractor so
// there's one notion of "app-origin frame".
function callSite(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  return sourceFromStack(stripLoggerFrames(stack))
}

function splitContext(context?: LogContext): {
  record: boolean
  org?: string
  rest: Record<string, unknown>
} {
  if (!context) return { record: false, rest: {} }
  const { record, org, ...rest } = context
  return { record: Boolean(record), org, rest }
}

// Error-shaped context values (a stray `{ err }`) carry sensitive fields the
// privacy contract forbids in a log line: a GitHubAPIError exposes the raw
// response `body` and the `ssoHeader` (an authorization_request token). Project
// to an ALLOW-LIST of known non-sensitive scalar fields (matching the Activity
// store's allow-list philosophy) so a caller can't leak by handing us the raw
// error — anything not explicitly listed is dropped. Both the console sink and
// the record path consume the sanitized context.
const SAFE_ERROR_KEYS = new Set(["status", "requestId"])

function sanitizeValue(value: unknown): unknown {
  if (!(value instanceof Error)) return value
  const safe: Record<string, unknown> = {
    name: value.name,
    message: value.message,
  }
  for (const [key, v] of Object.entries(value)) {
    if (!SAFE_ERROR_KEYS.has(key)) continue
    // Only scalars — never a nested object/array (could carry a body/header).
    if (v === null || typeof v !== "object") safe[key] = v
  }
  return safe
}

function sanitizeContext(
  rest: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    out[key] = sanitizeValue(value)
  }
  return out
}

function emit(
  level: LogLevel,
  scope: string | undefined,
  message: string,
  context?: LogContext,
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return

  const { record, org, rest } = splitContext(context)
  const site = callSite()
  const safeRest = sanitizeContext(rest)

  const prefix = [
    new Date().toISOString(),
    level.toUpperCase(),
    scope ? `[${scope}]` : undefined,
    site ? `(${site})` : undefined,
  ]
    .filter(Boolean)
    .join(" ")

  const line = `${prefix} ${message}`
  const hasContext = Object.keys(safeRest).length > 0
  // Indexed by level (which IS the console method name) and looked up lazily
  // (not bound at module load) so it respects a console the host swaps out — a
  // test spy, or a wrapper installed after this module loaded. Each level maps
  // to its matching method so devtools can filter by severity. `console.debug`
  // exists in every target browser + node.
  const sink = console[level]
  if (hasContext) {
    sink(line, safeRest)
  } else {
    sink(line)
  }

  // Opt-in mirror into the session Activity store so a user's diagnostics
  // snapshot reflects this line. Only meaningful for warn/error (the store is
  // an error/action record); label is the scope-qualified message.
  if (record && (level === "error" || level === "warn")) {
    // Strip this module's frames from the fresh error's stack so the recorded
    // entry's `source` resolves to the real caller (the same frame as `site`),
    // not logger.ts — toActivityEntry prefers the error's own stack.
    const recordErr = new Error(message)
    if (recordErr.stack) {
      recordErr.stack = stripLoggerFrames(recordErr.stack)
    }
    recordError(recordErr, {
      org,
      label: scope ? `[${scope}] ${message}` : message,
      source: site,
      // Collapse a burst of identical recorded lines (e.g. one warn per 401 in
      // a multi-org read) into one Activity entry so the ring doesn't evict
      // genuine errors — same window the mutation/toast paths use.
      dedupKey: scope ? `log-${scope}-${message}` : `log-${message}`,
    })
  }
}

export type Logger = {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
  // A child logger tagged with a nested scope, e.g.
  // logger.scope("mutations").scope("students") → "mutations:students".
  scope(name: string): Logger
}

function make(scope?: string): Logger {
  return {
    debug: (message, context) => emit("debug", scope, message, context),
    info: (message, context) => emit("info", scope, message, context),
    warn: (message, context) => emit("warn", scope, message, context),
    error: (message, context) => emit("error", scope, message, context),
    scope: (name) => make(scope ? `${scope}:${name}` : name),
  }
}

// The app-wide logger. Prefer a scoped child at a module boundary
// (`const log = logger.scope("mutations:students")`) so origin is greppable.
export const logger: Logger = make()
