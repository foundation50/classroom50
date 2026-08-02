// Per-classroom roster file path. The filename is a byte-mirror of the CLI's
// cli/shared/contract (RosterFilename) — a cross-tool contract with no
// compile-time link across Go and TypeScript, so keep them in lockstep.

export function rosterPath(classroom: string): string {
  return `${classroom}/roster.csv`
}
