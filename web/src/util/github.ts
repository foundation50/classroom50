export function decodeBase64Utf8(base64: string) {
  const binary = atob(base64.replace(/\n/g, ""))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
