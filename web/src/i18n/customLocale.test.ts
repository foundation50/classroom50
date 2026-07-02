import { describe, expect, it } from "vitest"

import {
  LanguagePackError,
  MAX_PACK_BYTES,
  flattenBundle,
  loadFromUrl,
  normalizeLangCode,
  parseBundle,
} from "./customLocale"

// The security-relevant guarantees of the sideload layer live in these pure
// functions: nested-JSON flattening with non-string rejection, the pre-parse
// byte cap, shape validation, language-code normalization, and the URL scheme
// gate. They run without a DOM (the repo's tests use the node environment).

describe("flattenBundle", () => {
  it("flattens nested objects into dotted keys", () => {
    expect(flattenBundle({ notFound: { title: "x", message: "y" } })).toEqual({
      "notFound.title": "x",
      "notFound.message": "y",
    })
  })

  it("rejects non-string leaves", () => {
    expect(() => flattenBundle({ a: 1 })).toThrow(LanguagePackError)
    expect(() => flattenBundle({ a: ["x"] })).toThrow(LanguagePackError)
  })

  it("rejects non-object input", () => {
    expect(() => flattenBundle("nope")).toThrow(LanguagePackError)
    expect(() => flattenBundle(["a"])).toThrow(LanguagePackError)
    expect(() => flattenBundle(null)).toThrow(LanguagePackError)
  })
})

describe("parseBundle", () => {
  it("parses and flattens valid JSON", () => {
    expect(parseBundle('{"notFound":{"title":"Nicht gefunden"}}')).toEqual({
      "notFound.title": "Nicht gefunden",
    })
  })

  it("rejects invalid JSON", () => {
    expect(() => parseBundle("{not json")).toThrow(LanguagePackError)
  })

  it("rejects an empty bundle", () => {
    expect(() => parseBundle("{}")).toThrow(LanguagePackError)
  })

  it("rejects input over the byte cap before parsing", () => {
    const huge = JSON.stringify({ k: "a".repeat(MAX_PACK_BYTES + 1) })
    expect(() => parseBundle(huge)).toThrow(/too large/)
  })
})

describe("normalizeLangCode", () => {
  it("accepts BCP-47-ish codes", () => {
    expect(normalizeLangCode("de")).toBe("de")
    expect(normalizeLangCode(" pt-BR ")).toBe("pt-BR")
  })

  it("rejects codes with unexpected characters", () => {
    expect(() => normalizeLangCode("de/../x")).toThrow(LanguagePackError)
    expect(() => normalizeLangCode("a")).toThrow(LanguagePackError)
  })
})

describe("loadFromUrl scheme gate", () => {
  it("rejects non-http(s) schemes before fetching", async () => {
    await expect(loadFromUrl("file:///etc/passwd", "de")).rejects.toThrow(
      /http\(s\)/,
    )
    await expect(
      loadFromUrl("data:application/json,{}", "de"),
    ).rejects.toThrow(/http\(s\)/)
  })

  it("rejects a malformed URL", async () => {
    await expect(loadFromUrl("not a url", "de")).rejects.toThrow(
      LanguagePackError,
    )
  })
})
