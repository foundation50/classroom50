import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// Source-tree walk for the guard tests that scan src/** (contrast tiers, VPAT
// architectural claims, config-repo path templates). Two things every scanner
// needs and none should hand-roll:
//
// - Skip the `__*_probe_*` directories the boundary tests (eslintBoundaries,
//   dependencyCruiser, noCycleGuard, authz/boundaryGuard) create and delete
//   under src/ while they run. Vitest shards run in parallel, so a scanner in
//   one shard can list a probe file that a prober in another shard removes
//   before the read; that race was a CI-only ENOENT.
// - Tolerate a file vanishing between the listing and the read for the same
//   reason: a missing file is not a scan finding.
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
