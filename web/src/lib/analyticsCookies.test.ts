import { describe, expect, it } from "vitest"

import { clearAnalyticsCookies } from "./analyticsCookies"

// A jar that records every write instead of applying cookie semantics, so the
// test can assert exactly which names and domains were expired.
function jar(initial: string) {
  const writes: string[] = []
  return {
    doc: {
      get cookie() {
        return initial
      },
      set cookie(value: string) {
        writes.push(value)
      },
    },
    writes,
  }
}

describe("clearAnalyticsCookies", () => {
  it("expires Google Analytics cookies on the host and each parent domain", () => {
    const { doc, writes } = jar(
      "_ga=GA1.1.1; _ga_ABC123=GS1.1; _gid=x; theme=sumi; classroom50=keep",
    )
    clearAnalyticsCookies(doc, "preview.classroom50.org")

    const expired = writes.map((w) => w.split(";")[0])
    expect(new Set(expired)).toEqual(new Set(["_ga=", "_ga_ABC123=", "_gid="]))
    expect(writes.every((w) => w.includes("expires=Thu, 01 Jan 1970"))).toBe(
      true,
    )
    const gaWrites = writes.filter((w) => w.startsWith("_ga="))
    expect(gaWrites.map((w) => w.match(/domain=([^;]+)/)?.[1])).toEqual([
      undefined,
      "preview.classroom50.org",
      "classroom50.org",
    ])
  })

  it("does nothing when no analytics cookies are present", () => {
    const { doc, writes } = jar("theme=sumi; _gasp=not-ours")
    clearAnalyticsCookies(doc, "classroom50.org")
    expect(writes).toEqual([])
  })

  it("never names a single-label domain", () => {
    const { doc, writes } = jar("_ga=1")
    clearAnalyticsCookies(doc, "localhost")
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toContain("domain=")
  })
})
