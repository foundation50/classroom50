// Read a File's bytes and base64-encode them for the GitHub git-blob API
// (encoding:"base64"). Binary-safe — unlike File.text(), which would corrupt
// non-UTF-8 content. Chunked so a large file can't blow the call stack via
// String.fromCharCode(...wholeArray) (spreading a big array overflows).
export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  return bytesToBase64(new Uint8Array(buf))
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000 // 32k code units per fromCharCode call — well under limits
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
