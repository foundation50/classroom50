// Authoring helpers for an assignment's `allowed_files`: an ordered,
// .gitignore-style allowlist (last match wins, `!` re-includes; empty = all
// allowed). Edited as a textarea (one pattern per line); these convert to/from
// the wire-shape `string[]`. Validation mirrors the CLI's ValidateAllowedFiles
// and the assignments-v1 schema so a bad value is caught here, not by a rejected
// commit.

export const ALLOWED_FILES_CAP = 100

// One pattern per line; blank lines dropped. Strips only the line separator
// (trailing CR from CRLF) — other whitespace is significant in .gitignore and
// stored verbatim by the CLI, so rewriting it would corrupt CLI-authored
// patterns on re-save. Order preserved (last match wins).
export function parseAllowedFiles(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")
}

// Join stored patterns into textarea content for editing.
export function allowedFilesToText(patterns: string[] | undefined): string {
  return (patterns ?? []).join("\n")
}

// Mirror gh-teacher's ValidateAllowedFiles. Returns an error message, or
// undefined when valid. Empty list is valid (all files allowed).
export function validateAllowedFiles(patterns: string[]): string | undefined {
  if (patterns.length > ALLOWED_FILES_CAP) {
    return `Too many patterns (${patterns.length}) — ${ALLOWED_FILES_CAP} max.`
  }
  for (const pattern of patterns) {
    if (pattern.trim() === "") {
      return "A pattern must not be empty."
    }
    if (pattern.includes("\u0000")) {
      return "A pattern must not contain a NUL character."
    }
  }
  return undefined
}
