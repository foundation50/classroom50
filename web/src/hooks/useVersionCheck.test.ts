import { describe, expect, it } from "vitest"

import { resolveUpdateAvailable } from "./useVersionCheck"

// Realistic hash widths: CI stamps full 40-char shas, local builds 12-char.
const runningFull = "a".repeat(40)
const deployedFull = "b".repeat(40)

describe("resolveUpdateAvailable", () => {
  it("prompts when the deployed commit differs from the running commit", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: deployedFull,
        runningCommit: runningFull,
      }),
    ).toBe(true)
  })

  it("stays quiet when the commits are identical", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: runningFull,
        runningCommit: runningFull,
      }),
    ).toBe(false)
  })

  it("stays quiet when the running short hash prefixes the deployed sha (local build of the deployed commit)", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: runningFull,
        runningCommit: runningFull.slice(0, 12),
      }),
    ).toBe(false)
  })

  it("stays quiet when the deployed hash prefixes the running sha (symmetry)", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: runningFull.slice(0, 12),
        runningCommit: runningFull,
      }),
    ).toBe(false)
  })

  it("fails open when the deployed commit is missing (fetch/parse failure)", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: undefined,
        runningCommit: runningFull,
      }),
    ).toBe(false)
  })

  it("fails open when the deployed commit is empty (malformed manifest)", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: "",
        runningCommit: runningFull,
      }),
    ).toBe(false)
  })

  it("stays quiet for a dev build with no stamped commit", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: deployedFull,
        runningCommit: "unknown",
      }),
    ).toBe(false)
  })

  it("fails open when the running commit is empty", () => {
    expect(
      resolveUpdateAvailable({
        deployedCommit: deployedFull,
        runningCommit: "",
      }),
    ).toBe(false)
  })
})
