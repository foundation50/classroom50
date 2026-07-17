// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"

import { applyDocumentDirection, isRtlLang } from "./direction"

// RTL detection must match the primary subtag (users sideload arbitrary BCP-47
// codes like "ar-EG"), case-insensitively, and never throw on odd input.

describe("isRtlLang", () => {
  it("matches RTL primary subtags", () => {
    expect(isRtlLang("ar")).toBe(true)
    expect(isRtlLang("he-IL")).toBe(true)
    expect(isRtlLang("fa")).toBe(true)
    expect(isRtlLang("ur")).toBe(true)
  })

  it("matches region variants by primary subtag", () => {
    expect(isRtlLang("ar-EG")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isRtlLang("AR")).toBe(true)
  })

  it("rejects LTR and empty codes", () => {
    expect(isRtlLang("en")).toBe(false)
    expect(isRtlLang("tr")).toBe(false)
    expect(isRtlLang("")).toBe(false)
  })
})

describe("applyDocumentDirection", () => {
  it("sets dir=rtl and lang for an RTL language", () => {
    applyDocumentDirection("ar")
    expect(document.documentElement.dir).toBe("rtl")
    expect(document.documentElement.lang).toBe("ar")
  })

  it("sets dir=ltr and lang for an LTR language", () => {
    applyDocumentDirection("en")
    expect(document.documentElement.dir).toBe("ltr")
    expect(document.documentElement.lang).toBe("en")
  })
})
