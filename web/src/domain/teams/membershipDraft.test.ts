import { describe, expect, it } from "vitest"

import { resolveMembershipDraft } from "./membershipDraft"

const CURRENT = ["Alice", "bob", "carol"]

describe("resolveMembershipDraft", () => {
  it("reports no changes for an empty draft", () => {
    const draft = resolveMembershipDraft({
      currentMembers: CURRENT,
      removals: new Set(),
      additions: [],
      maxGroupSize: 4,
    })
    expect(draft).toEqual({
      toRemove: [],
      toAdd: [],
      resultingCount: 3,
      hasChanges: false,
      atCapacity: false,
      overCapacity: false,
    })
  })

  it("matches removals case-insensitively and keeps original casing", () => {
    const draft = resolveMembershipDraft({
      currentMembers: CURRENT,
      removals: new Set(["alice"]),
      additions: [],
    })
    expect(draft.toRemove).toEqual(["Alice"])
    expect(draft.resultingCount).toBe(2)
    expect(draft.hasChanges).toBe(true)
  })

  it("ignores a removal of a non-member and an addition of a member", () => {
    const draft = resolveMembershipDraft({
      currentMembers: CURRENT,
      removals: new Set(["mallory"]),
      additions: ["BOB", "dave"],
    })
    expect(draft.toRemove).toEqual([])
    expect(draft.toAdd).toEqual(["dave"])
    expect(draft.resultingCount).toBe(4)
  })

  it("dedupes additions and drops blanks", () => {
    const draft = resolveMembershipDraft({
      currentMembers: [],
      removals: new Set(),
      additions: ["dave", "Dave", "  ", "erin"],
    })
    expect(draft.toAdd).toEqual(["dave", "erin"])
    expect(draft.resultingCount).toBe(2)
  })

  it("gates capacity on the DRAFT count, freeing a slot per pending removal", () => {
    // 3 live - 1 pending removal + 1 pending add = 3 of 3: at capacity.
    const atCap = resolveMembershipDraft({
      currentMembers: CURRENT,
      removals: new Set(["bob"]),
      additions: ["dave"],
      maxGroupSize: 3,
    })
    expect(atCap.resultingCount).toBe(3)
    expect(atCap.atCapacity).toBe(true)

    // The pending removal alone frees a slot below the cap.
    const roomy = resolveMembershipDraft({
      currentMembers: CURRENT,
      removals: new Set(["bob"]),
      additions: [],
      maxGroupSize: 3,
    })
    expect(roomy.atCapacity).toBe(false)
  })

  it("is never at capacity without a cap", () => {
    const draft = resolveMembershipDraft({
      currentMembers: CURRENT,
      removals: new Set(),
      additions: ["dave", "erin"],
    })
    expect(draft.atCapacity).toBe(false)
    expect(draft.overCapacity).toBe(false)
  })

  it("flags a live group past the cap until pending removals bring it back", () => {
    // 4 live members against a cap of 3 (added on GitHub directly, #896).
    const live = ["alice", "bob", "carol", "dave"]
    const over = resolveMembershipDraft({
      currentMembers: live,
      removals: new Set(),
      additions: [],
      maxGroupSize: 3,
    })
    expect(over.overCapacity).toBe(true)
    expect(over.atCapacity).toBe(true)

    // One pending removal lands exactly on the cap: full, no longer over.
    const fixed = resolveMembershipDraft({
      currentMembers: live,
      removals: new Set(["dave"]),
      additions: [],
      maxGroupSize: 3,
    })
    expect(fixed.overCapacity).toBe(false)
    expect(fixed.atCapacity).toBe(true)
  })
})
