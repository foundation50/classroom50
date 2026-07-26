// A user-facing message that has been *named* but not yet rendered: a
// translation key plus its interpolation params. Layers below the view carry
// this instead of assembled English, so a non-English student never sees a
// hardcoded sentence. Mirrors github-core's CheckDetail so the codebase has one
// idea of a deferred string; a param may itself be a LocalizedMessage, which is
// how a clause (e.g. GitHub's own words) nests inside a sentence without
// splitting either key into fragments.
export type LocalizedMessage = {
  key: string
  params?: Record<string, LocalizedParam>
}

export type LocalizedParam = string | number | LocalizedMessage

// The one thing a resolver needs from i18next, so this leaf module stays free of
// an i18n dependency (and of any view-layer import).
export type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
) => string

function isLocalizedMessage(value: LocalizedParam): value is LocalizedMessage {
  return typeof value === "object" && value !== null && "key" in value
}

// Render a deferred message at the view layer, resolving nested params first.
export function resolveLocalizedMessage(
  t: TranslateFn,
  message: LocalizedMessage,
): string {
  const params = message.params
  if (!params) return t(message.key)
  const resolved: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(params)) {
    resolved[name] = isLocalizedMessage(value)
      ? resolveLocalizedMessage(t, value)
      : value
  }
  return t(message.key, resolved)
}

// The deferred message an error carries, if any. Duck-typed rather than keyed
// off the error classes: this leaf module can't import domain/ or util/, and the
// view only needs "does this error name a message?".
export function localizedMessageOf(err: unknown): LocalizedMessage | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const candidate = (err as { localized?: unknown }).localized
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as LocalizedMessage).key === "string"
  ) {
    return candidate as LocalizedMessage
  }
  return undefined
}

// Diagnostic (never rendered) form of a deferred message, used as the `message`
// of an Error that carries one. Keeps logs and any `err.message` reader useful
// without assembling English below the view layer.
export function describeLocalizedMessage(message: LocalizedMessage): string {
  const params = message.params
  if (!params) return message.key
  const detail = Object.entries(params)
    .map(([name, value]) => {
      const rendered = isLocalizedMessage(value)
        ? describeLocalizedMessage(value)
        : String(value)
      return `${name}=${rendered}`
    })
    .join(", ")
  return detail ? `${message.key} (${detail})` : message.key
}

// Attach a deferred message to an error. Additive on purpose: `Error.message`
// stays as-is for log/outage consumers, while a descriptor-aware view (the accept
// page) resolves `localized` instead.
function withLocalizedMessage<E extends Error>(
  err: E,
  localized: LocalizedMessage,
): E {
  return Object.assign(err, { localized })
}

// A new error that carries only a deferred message. `Error.message` is the
// diagnostic form, so logs stay readable.
export function localizedError(localized: LocalizedMessage): Error {
  return withLocalizedMessage(
    new Error(describeLocalizedMessage(localized)),
    localized,
  )
}
