import { describe, expect, it } from "vitest"

import { isSelfHostedRunnerValue, verifyRunnerLabels } from "./runners"

describe("isSelfHostedRunnerValue", () => {
  it("is false for empty / hosted labels (built-in runtime options apply)", () => {
    expect(isSelfHostedRunnerValue("")).toBe(false)
    expect(isSelfHostedRunnerValue("   ")).toBe(false)
    expect(isSelfHostedRunnerValue("ubuntu-latest")).toBe(false)
    expect(isSelfHostedRunnerValue("macos-latest")).toBe(false)
  })

  it("is true when a standard self-hosted label is present", () => {
    expect(isSelfHostedRunnerValue("self-hosted")).toBe(true)
    expect(isSelfHostedRunnerValue("self-hosted, linux, x64")).toBe(true)
    // Order/whitespace/case-insensitive, matching label parsing.
    expect(isSelfHostedRunnerValue("linux, Self-Hosted")).toBe(true)
  })

  it("stays false for a lone custom label (ambiguous — not confirmed self-hosted)", () => {
    // Mirrors verifyRunnerLabels' no-org-access verdict: a lone unrecognized
    // label is `unknown`, not `self-hosted`, so options stay enabled rather
    // than disabling on an unverifiable value.
    expect(isSelfHostedRunnerValue("gpu")).toBe(false)
  })

  it("stays in lockstep with the RunnerField self-hosted verdict", () => {
    const noAccess = { available: false, reason: "no-access" } as const
    for (const raw of [
      "",
      "ubuntu-latest",
      "self-hosted",
      "self-hosted, linux, x64",
      "gpu",
    ]) {
      expect(isSelfHostedRunnerValue(raw)).toBe(
        verifyRunnerLabels(raw, noAccess).kind === "self-hosted",
      )
    }
  })
})
