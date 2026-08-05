import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

// Guards the vitest two-project wiring so the browser-only a11y layout guards
// (2.5.8 target size, 1.4.10 reflow) can't silently stop running. Two silent-pass
// surfaces this closes (code review findings #1, #2):
//   1. `npm test` runs both projects only while `test.projects` stays configured;
//      a revert to a single `test` block would drop the browser guards and CI
//      would still pass.
//   2. If the `*.browser.test.tsx` glob ever matched zero files, the browser
//      project would run empty (0 tests = green) with the two flipped VPAT
//      criteria losing their backing.
// Lives in the node project (no browser needed): it reads the config + globs the
// tree, so it runs in the fast suite and fails loudly if the wiring regresses.

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, "..", "..")

describe("vitest browser-project wiring (a11y layout guards)", () => {
  const config = readFileSync(path.join(webRoot, "vite.config.ts"), "utf8")

  it("vite config declares both a node and a browser project", () => {
    expect(config).toMatch(/name:\s*"node"/)
    expect(config).toMatch(/name:\s*"browser"/)
  })

  it("the node project excludes browser tests (no double-run)", () => {
    expect(config).toMatch(
      /exclude:\s*\[\s*"src\/\*\*\/\*\.browser\.test\.tsx"/,
    )
  })

  it("the browser project targets *.browser.test.tsx", () => {
    expect(config).toMatch(
      /name:\s*"browser"[\s\S]*include:\s*\[\s*"src\/\*\*\/\*\.browser\.test\.tsx"/,
    )
  })

  it("at least four browser guard files exist to be collected", () => {
    const files = globSync("src/**/*.browser.test.tsx", { cwd: webRoot })
    // 2.5.8 target size, 1.4.10 reflow, 1.4.4 resize text, 1.4.12 text spacing.
    // Fewer means a guard was renamed out of the collected glob and its VPAT
    // criterion lost its backing check.
    expect(files.length).toBeGreaterThanOrEqual(4)
  })
})
