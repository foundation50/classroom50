// Lowercase hex of a byte array. Output is lowercase, zero-padded, no separator.
export function bytesToHex(bytes: Uint8Array): string {
  return bytes.toHex()
}
