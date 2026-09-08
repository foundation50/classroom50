import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

import { isSourceTs, readSourceFile, walkSourceFiles } from "@/test/walkSource"
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
    for (const full of walkSourceFiles(srcRoot, isSourceTs)) {
      if (full.endsWith("configRepoPaths.ts")) continue
      const text = readSourceFile(full)
      if (text !== null && template.test(text)) {
        offenders.push(relative(srcRoot, full))
      }
    }
    expect(offenders).toEqual([])
  })
})
