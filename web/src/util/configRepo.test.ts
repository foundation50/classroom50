import { describe, expect, it } from "vitest"
import { CONFIG_REPO, DEFAULT_BRANCH } from "./configRepo"

describe("config-repo constants", () => {
  // Pins the literal so it can't drift from the CLI's cli/shared/contract
  // ConfigRepoName and the schema $id prefixes (no compile-time link across the
  // three). A rename here without updating the Go/schema side silently breaks
  // config-repo reads/writes; this guard turns that into a failing test.
  it("uses the classroom50 config-repo name", () => {
    expect(CONFIG_REPO).toBe("classroom50")
  })

  // Web-internal convention (not a cli/shared/contract value): the branch the
  // config repo is normalized to and the last-resort fallback. Pinned so the
  // "make main a one-line change" intent doesn't accidentally shift the current
  // value.
  it("defaults the branch to main", () => {
    expect(DEFAULT_BRANCH).toBe("main")
  })
})
