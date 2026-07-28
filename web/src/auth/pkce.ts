function base64Url(bytes: Uint8Array) {
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true })
}

export function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

export function generateVerifier() {
  return randomBase64Url(32)
}

export async function deriveChallenge(verifier: string) {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  return base64Url(new Uint8Array(digest))
}
