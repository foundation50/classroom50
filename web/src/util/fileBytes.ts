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

export interface DecodedTextFile {
  text: string
  /** True when the file wasn't valid UTF-8 and was decoded as Windows-1252. */
  fallbackUsed: boolean
}

// Decode a teacher-supplied text file without assuming UTF-8. File.text()
// decodes as UTF-8 in non-fatal mode, so a Windows-1252 file (Excel's plain
// "CSV" export on Windows) turns every non-ASCII byte into U+FFFD (issue
// #742). Order: BOM sniff (UTF-8/UTF-16 — TextDecoder strips the BOM itself),
// then strict UTF-8, then Windows-1252 — which decodes any byte sequence, so
// this never throws. A non-1252 legacy code page decodes as visible mojibake
// the preview step lets the teacher catch.
export async function decodeTextFile(file: File): Promise<DecodedTextFile> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const bomEncoding = detectBomEncoding(bytes)
  if (bomEncoding) {
    return {
      text: new TextDecoder(bomEncoding).decode(bytes),
      fallbackUsed: false,
    }
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      fallbackUsed: false,
    }
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      fallbackUsed: true,
    }
  }
}

function detectBomEncoding(
  bytes: Uint8Array,
): "utf-8" | "utf-16le" | "utf-16be" | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return "utf-8"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  return null
}
