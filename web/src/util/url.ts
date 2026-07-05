// Guards hrefs built from untrusted data (e.g. a student's committed
// `result.json`): a `javascript:`/`data:` href is a script sink, so only
// http(s) links are safe to render.

export function isSafeHttpUrl(
  value: string | null | undefined,
): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    // Not an absolute URL (or malformed) — reject.
    return false
  }
}

// The URL when safe, else undefined so callers can omit the link.
export function safeHttpUrl(
  value: string | null | undefined,
): string | undefined {
  return isSafeHttpUrl(value) ? value : undefined
}
