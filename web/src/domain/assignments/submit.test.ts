import { describe, expect, it } from "vitest"

import { buildSubmitTag } from "./submit"

describe("buildSubmitTag", () => {
  it("formats submit/<UTC-timestamp>-<short-sha> (runner/CLI parity)", () => {
    // Byte-format parity with the runner's `date -u +%Y-%m-%dT%H-%M-%SZ` and
    // Go's contract.BuildSubmitTag (pinned by TestBuildSubmitTag).
    const at = new Date(Date.UTC(2026, 7, 3, 14, 30, 5))
    expect(buildSubmitTag("abcdef0123456789", at)).toBe(
      "submit/2026-08-03T14-30-05Z-abcdef0",
    )
  })
})
