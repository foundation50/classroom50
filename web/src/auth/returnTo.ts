// Open-redirect guard for post-auth / post-onboarding return targets: accept
// only a same-origin relative path. Beyond the leading-single-slash checks
// (which reject "//host" and absolute URLs), we also reject vectors that a
// naive startsWith("/") misses and then confirm same-origin via the URL parser
// so the guard owns its property rather than relying on a browser quirk:
//   - "\": URL parsers treat it as "/", so "/\evil.com" resolves cross-origin.
//   - Encoded slashes/backslashes (%2F, %5C): a downstream decode can restore "//".
//   - ASCII control chars: parsers strip some, shifting how the value resolves.
const SAME_ORIGIN_FALLBACK = "http://localhost"

export function isSafeReturnTo(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return false
  }

  if (value.includes("\\") || /%2f|%5c/i.test(value)) {
    return false
  }

  // Reject ASCII control chars (tab/CR/LF, DEL); URL parsers strip some.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : SAME_ORIGIN_FALLBACK

  try {
    return new URL(value, origin).origin === origin
  } catch {
    return false
  }
}
