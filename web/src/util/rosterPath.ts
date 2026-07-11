// Per-classroom roster file paths. The filenames are byte-mirrors of the CLI's
// cli/shared/contract (RosterFilename / LegacyRosterFilename) — a cross-tool
// contract with no compile-time link across Go and TypeScript, so keep them in
// lockstep. Readers try roster.csv and fall back to the legacy students.csv;
// writers always target roster.csv.

export function rosterPath(classroom: string): string {
  return `${classroom}/roster.csv`
}

export function legacyRosterPath(classroom: string): string {
  return `${classroom}/students.csv`
}
