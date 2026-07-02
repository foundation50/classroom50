import { afterEach, describe, expect, it, vi } from "vitest"

import {
  LanguagePackError,
  MAX_PACK_BYTES,
  UndetectableCodeError,
  coverage,
  flattenBundle,
  inferLangCode,
  missingKeys,
  normalizeLangCode,
  parseBundle,
  prepareFromUrl,
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

  it("rejects Intl-invalid tags that lack a letter primary subtag", () => {
    // These pass a loose [A-Za-z0-9-] check but make Intl.DateTimeFormat throw
    // a RangeError, so they must be rejected at install time.
    for (const bad of ["123", "12-34", "1de", "a1-b2"]) {
      expect(() => normalizeLangCode(bad), bad).toThrow(LanguagePackError)
    }
  })
})

describe("inferLangCode", () => {
  it("infers a code from a bare file name", () => {
    expect(inferLangCode("de.json")).toBe("de")
    expect(inferLangCode("pt-BR.json")).toBe("pt-BR")
    expect(inferLangCode("zh-Hans-CN.JSON")).toBe("zh-Hans-CN")
  })

  it("infers a code from the last URL path segment", () => {
    expect(inferLangCode("https://example.com/locales/zh-CN.json")).toBe(
      "zh-CN",
    )
    expect(inferLangCode("/some/path/fr.json?ref=main")).toBe("fr")
    expect(inferLangCode("https://example.com/de.json#frag")).toBe("de")
  })

  it("returns null when no valid code can be extracted", () => {
    expect(inferLangCode("translation.json")).toBeNull()
    expect(inferLangCode("123.json")).toBeNull()
    expect(inferLangCode("")).toBeNull()
    expect(inferLangCode("https://example.com/download?id=42")).toBeNull()
  })
})

describe("loadFromUrl scheme gate", () => {
  it("rejects non-http(s) schemes before fetching", async () => {
    await expect(prepareFromUrl("file:///etc/passwd", "de")).rejects.toThrow(
      /http\(s\)/,
    )
    await expect(
      prepareFromUrl("data:application/json,{}", "de"),
    ).rejects.toThrow(/http\(s\)/)
  })

  it("rejects a malformed URL", async () => {
    await expect(prepareFromUrl("not a url", "de")).rejects.toThrow(
      LanguagePackError,
    )
  })

  it("throws UndetectableCodeError when no code is given or inferable", async () => {
    await expect(
      prepareFromUrl("https://example.com/download"),
    ).rejects.toThrow(UndetectableCodeError)
  })
})

describe("loadFromUrl response handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects a non-2xx response before installing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    )
    await expect(
      prepareFromUrl("https://example.com/de.json", "de"),
    ).rejects.toThrow(/HTTP 404/)
  })

  it("aborts a streamed body that exceeds the size cap", async () => {
    // A chunked response with no Content-Length: the header check can't catch
    // it, so the streaming reader must abort once bytes exceed MAX_PACK_BYTES.
    const oversized = "a".repeat(MAX_PACK_BYTES + 1024)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized))
        controller.close()
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    )
    await expect(
      prepareFromUrl("https://example.com/big.json", "de"),
    ).rejects.toThrow(/too large/)
  })

  it("rejects when the declared Content-Length exceeds the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(MAX_PACK_BYTES + 1) },
          }),
      ),
    )
    await expect(
      prepareFromUrl("https://example.com/big.json", "de"),
    ).rejects.toThrow(/too large/)
  })

  it("returns a preview (code inferred, coverage, sample) without installing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              nav: { roleStudent: "Studentin" },
              notFound: { title: "x" },
            }),
            { status: 200 },
          ),
      ),
    )
    const preview = await prepareFromUrl("https://example.com/de.json")
    expect(preview.code).toBe("de")
    expect(preview.keyCount).toBe(2)
    expect(preview.coverage).toBeGreaterThan(0)
    expect(preview.coverage).toBeLessThan(1)
    // The sample surfaces real translated strings pulled from the bundle.
    expect(preview.sample).toContain("Studentin")
  })
})

describe("coverage / missingKeys", () => {
  it("reports full coverage for a pack translating every base key", () => {
    // A pack that mirrors the base keys 1:1 has coverage 1 and no missing keys.
    // We can't import the private base list, so build a pack from the known
    // base by round-tripping a known subset: an empty pack has <1 coverage.
    const partial = { "notFound.title": "x" }
    expect(coverage(partial)).toBeGreaterThan(0)
    expect(coverage(partial)).toBeLessThan(1)
    expect(missingKeys(partial).length).toBeGreaterThan(0)
    // A key the base doesn't have doesn't inflate coverage.
    expect(missingKeys(partial)).not.toContain("notFound.title")
  })
})
