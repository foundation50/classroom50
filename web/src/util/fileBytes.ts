// Read a File's bytes and base64-encode them for the GitHub git-blob API
// (encoding:"base64"). Binary-safe — unlike File.text(), which would corrupt
// non-UTF-8 content.
export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  return bytesToBase64(new Uint8Array(buf))
}

export function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64()
}
