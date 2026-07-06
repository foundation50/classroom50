import { describe, expect, it } from "vitest"

import type { MemberDefaultSetting } from "@/orgPolicy/desiredState"

import {
  isOrgDefaultsStepData,
  unenforcedDefaultItems,
} from "./orgDefaultsStepData"

const setting = (field: string): MemberDefaultSetting => ({
  field,
  value: false,
  desc: `${field} desc`,
  manualFix: `fix ${field}`,
  critical: false,
  enterpriseOnly: false,
})

describe("isOrgDefaultsStepData", () => {
  it("accepts an object carrying both arrays", () => {
    expect(
      isOrgDefaultsStepData({ unenforced: [], enterprisePinned: [] }),
    ).toBe(true)
  })

  it("rejects null, non-objects, and missing/mistyped fields", () => {
    expect(isOrgDefaultsStepData(null)).toBe(false)
    expect(isOrgDefaultsStepData("nope")).toBe(false)
    expect(isOrgDefaultsStepData({ unenforced: [] })).toBe(false)
    expect(
      isOrgDefaultsStepData({ unenforced: {}, enterprisePinned: [] }),
    ).toBe(false)
  })
})

describe("unenforcedDefaultItems", () => {
  it("returns one row per unenforced field, flagging the enterprise-pinned subset", () => {
    const items = unenforcedDefaultItems({
      unenforced: [setting("a"), setting("b")],
      enterprisePinned: [setting("b")],
    })
    expect(items).toEqual([
      { field: "a", desc: "a desc", manualFix: "fix a", pinned: false },
      { field: "b", desc: "b desc", manualFix: "fix b", pinned: true },
    ])
  })

  it("returns an empty list when nothing is unenforced", () => {
    expect(
      unenforcedDefaultItems({ unenforced: [], enterprisePinned: [] }),
    ).toEqual([])
  })
})
