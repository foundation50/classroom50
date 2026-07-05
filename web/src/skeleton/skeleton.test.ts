import { describe, it, expect } from "vitest"

import {
  SKELETON_PATHS,
  buildSkeletonFiles,
  buildSkeletonFilesFromBundle,
  bundledSkeletonPaths,
  DEFAULT_BRANCH_PLACEHOLDER,
} from "./skeleton"

// Guards the bundled skeleton against drift from the CLI tree at
// cli/gh-teacher/skeleton/dotgithub.
describe("bundled skeleton", () => {
  it("bundles every path the GUI deploys", () => {
    const bundled = new Set(bundledSkeletonPaths())
    for (const rel of SKELETON_PATHS) {
      expect(bundled.has(rel), `missing bundled skeleton file: ${rel}`).toBe(
        true,
      )
    }
  })

  it("deploys every bundled path it declares (no silent CLI-side additions)", () => {
    // Reverse of the check above: a skeleton file the CLI commits (now bundled)
    // that the GUI forgot to add to SKELETON_PATHS would ship via
    // `gh teacher init` but never via GUI org setup — silently reopening the
    // action-parity gap this bundling closes. Fail the build instead.
    const declared = new Set<string>(SKELETON_PATHS)
    for (const rel of bundledSkeletonPaths()) {
      expect(
        declared.has(rel),
        `bundled skeleton file not deployed by the GUI (add to SKELETON_PATHS): ${rel}`,
      ).toBe(true)
    }
  })

  it("builds target-repo files under .github/ with non-empty content", () => {
    const files = buildSkeletonFiles("main")
    expect(files.length).toBe(SKELETON_PATHS.length)
    for (const file of files) {
      expect(file.path.startsWith(".github/")).toBe(true)
      expect(file.type).toBe("blob")
      expect(file.mode).toBe("100644")
      expect(file.content.length).toBeGreaterThan(0)
    }
  })

  it("substitutes the default-branch placeholder", () => {
    const files = buildSkeletonFiles("trunk")
    const publish = files.find(
      (f) => f.path === ".github/workflows/publish-pages.yaml",
    )
    expect(publish).toBeDefined()
    // Placeholder gone; the push trigger pins the resolved branch.
    expect(publish!.content).not.toContain(DEFAULT_BRANCH_PLACEHOLDER)
    expect(publish!.content).toContain("trunk")
  })

  it("bundles the regrade workflow + script the GUI dispatches", () => {
    const bundled = new Set(bundledSkeletonPaths())
    expect(bundled.has("workflows/regrade.yaml")).toBe(true)
    expect(bundled.has("scripts/regrade_repos.py")).toBe(true)
  })

  it("throws a build-bug error when a declared path is not bundled", () => {
    // The drift safety net buildSkeletonFiles relies on: a SKELETON_PATHS entry
    // missing from the bundle (renamed/removed/extension-swapped source) must
    // fail loudly at build time, not 404 a teacher's first org setup.
    const partialBundle = new Map<string, string>([
      ["workflows/publish-pages.yaml", "on: push\n"],
    ])
    expect(() =>
      buildSkeletonFilesFromBundle(SKELETON_PATHS, partialBundle, "main"),
    ).toThrow(/Bundled skeleton file missing: workflows\/collect-scores\.yaml/)
  })
})
