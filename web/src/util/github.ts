// Decode GitHub's base64 file content (Contents API) into a UTF-8 string. The
// payload is wrapped at column 60 with embedded newlines; Uint8Array.fromBase64
// is stricter about interior whitespace than atob, so strip it first.
export function decodeBase64Utf8(base64: string) {
  return new TextDecoder().decode(
    Uint8Array.fromBase64(base64.replace(/\s/g, "")),
  )
}
