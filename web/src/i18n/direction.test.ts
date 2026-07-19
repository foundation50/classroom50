// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { RTL_LANGS, applyDocumentDirection, isRtlLang } from "./direction"

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

// The anti-flash inline script in index.html hand-mirrors RTL_LANGS (same
// subtag list) so the pre-mount paint direction matches what the app resolves.
// Nothing else binds them and the drift symptom (an LTR flash for a newly
// added RTL language) is nearly invisible in review — guard the contract here,
// like the theme anti-flash test in useTheme.test.ts.
describe("RTL anti-flash contract (index.html <-> direction.ts)", () => {
  // Resolve from the vitest cwd (the web package root) rather than
  // import.meta.url: happy-dom's import.meta.url is not a file: URL.
  const indexHtml = readFileSync(path.join(process.cwd(), "index.html"), "utf8")

  it("index.html lists exactly the RTL_LANGS subtags", () => {
    // The anti-flash script holds the only bracketed string-array literal in
    // index.html; compare it as a set against RTL_LANGS so both an added and
    // a removed subtag fail, not just a missing one.
    const arrays = [...indexHtml.matchAll(/\[("[a-z-]+"\s*,\s*)+"[a-z-]+"\]/gi)]
    expect(arrays, "RTL subtag array not found in index.html").toHaveLength(1)
    const htmlLangs = [...arrays[0][0].matchAll(/"([a-z-]+)"/gi)].map(
      (m) => m[1],
    )
    expect(new Set(htmlLangs)).toEqual(RTL_LANGS)
  })

  it("index.html references the language storage key", () => {
    expect(indexHtml).toContain("classroom50:lang")
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
