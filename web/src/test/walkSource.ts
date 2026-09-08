import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// Source-tree walk for the guard tests that scan src/**. The boundary tests
// create and delete `__*_probe_*` directories under src/ while they run, and
// vitest shards run in parallel, so a scanner can list a probe file another
// shard removes before the read (a CI-only ENOENT). Skip those directories,
// and treat a file that vanishes mid-walk as absent, not as a finding.
const PROBE_DIR = /^__\w+_probe_/

export function walkSourceFiles(
  root: string,
  match: (name: string) => boolean,
): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (PROBE_DIR.test(name)) continue
      const full = path.join(dir, name)
      let isDir: boolean
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) visit(full)
      else if (match(name)) out.push(full)
    }
  }
  visit(root)
  return out
}

// The file's text, or null if it vanished after the walk listed it.
export function readSourceFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

// The common case: non-test TypeScript sources.
export const isSourceTs = (name: string) =>
  /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
