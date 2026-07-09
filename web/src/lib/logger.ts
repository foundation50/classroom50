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

// Each level maps to its own console method, so browser devtools can filter by
// severity (Verbose/Info/Warnings/Errors) and errors get a captured stack.
const CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
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

// First app frame of the CURRENT call, so a line prints "where it came from"
// even when no Error is passed. Reuses the activity store's frame extractor so
// there's one notion of "app-origin frame". We drop the top frames that are
// inside this module (logger.ts) to point at the real caller.
function callSite(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  const external = stack
    .split("\n")
    .filter((line) => !/logger\.(?:ts|js)/.test(line))
    .join("\n")
  return sourceFromStack(external)
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

function emit(
  level: LogLevel,
  scope: string | undefined,
  message: string,
  context?: LogContext,
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return

  const { record, org, rest } = splitContext(context)
  const site = callSite()

  const prefix = [
    new Date().toISOString(),
    level.toUpperCase(),
    scope ? `[${scope}]` : undefined,
    site ? `(${site})` : undefined,
  ]
    .filter(Boolean)
    .join(" ")

  const line = `${prefix} ${message}`
  const hasContext = Object.keys(rest).length > 0
  // Looked up lazily (not bound at module load) so it respects a console the
  // host swaps out — a test spy, or a wrapper installed after this module
  // loaded. `console.debug` exists in every target browser + node.
  const sink = console[CONSOLE_METHOD[level]]
  if (hasContext) {
    sink(line, rest)
  } else {
    sink(line)
  }

  // Opt-in mirror into the session Activity store so a user's diagnostics
  // snapshot reflects this line. Only meaningful for warn/error (the store is
  // an error/action record); label is the scope-qualified message.
  if (record && (level === "error" || level === "warn")) {
    recordError(new Error(message), {
      org,
      label: scope ? `[${scope}] ${message}` : message,
      source: site,
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
