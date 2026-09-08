import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assignmentsFilePath,
  classroomFilePath,
  rosterPath,
  scoresFilePath,
  teamsFilePath,
} from "./configRepoPaths"

describe("config-repo file paths", () => {
  // Pins every filename so none can drift from cli/shared/contract
  // (*Filename constants) and the Python skeleton (collect_scores.py
  // ROSTER_FILENAME). No compile-time link across the three tools.
  it.each([
    [assignmentsFilePath, "cs-principles/assignments.json"],
    [classroomFilePath, "cs-principles/classroom.json"],
    [scoresFilePath, "cs-principles/scores.json"],
    [teamsFilePath, "cs-principles/teams.json"],
    [rosterPath, "cs-principles/roster.csv"],
  ])("%o builds %s", (build, expected) => {
    expect(build("cs-principles")).toBe(expected)
  })

  // The builders exist so a reader's query key and a writer's invalidation
  // can't disagree on the path string. A hand-written template anywhere else
  // reopens that gap, so the sweep is pinned.
  it("is the only place that spells a per-classroom file path", () => {
    const srcRoot = join(__dirname, "..")
    const template =
      /`\$\{[^}]+\}\/(assignments\.json|classroom\.json|scores\.json|teams\.json|roster\.csv)`/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue
        if (full.endsWith("configRepoPaths.ts")) continue
        if (template.test(readFileSync(full, "utf8"))) {
          offenders.push(relative(srcRoot, full))
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual([])
  })
})
