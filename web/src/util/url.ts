// Guards hrefs built from untrusted data (e.g., a student's committed
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

// Normalize a user-typed website into a safe absolute http(s) URL, defaulting a
// bare host (no scheme, e.g., "classroom50.org") to https://. Uses the built-in
// WHATWG URL parser to validate; returns "" for blank input and undefined when
// the value can't be made into a safe http(s) URL (so callers can reject it).
// Trims surrounding whitespace first.
export function normalizeWebsiteUrl(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return ""
  // Prepend https:// when the input has no scheme (a bare host or path). A value
  // that already carries a scheme is validated as-is, so http:// is preserved
  // and a script sink like javascript: is rejected below.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  return safeHttpUrl(withScheme)
}
