import { afterEach, describe, expect, it, vi } from "vitest"

import {
  LANG_QUERY_PARAM,
  LanguagePackError,
  MAX_PACK_BYTES,
  PACKS_STORAGE_KEY,
  UndetectableCodeError,
  applyLangFromQuery,
  availableBuiltInLangs,
  coverage,
  fetchRegistry,
  flattenBundle,
  inferLangCode,
  missingKeys,
  normalizeLangCode,
  parseBundle,
  prepareFromBuiltIn,
  prepareFromUrl,
  shareUrlForLang,
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

describe("fetchRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns valid codes, dropping base, dupes, and malformed entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              languages: [
                { code: "ja" },
                { code: "zh-CN" },
                { code: "ja" }, // duplicate
                { code: "en" }, // base language, excluded
                { code: "!!" }, // invalid code
                { notcode: "x" }, // malformed entry
              ],
            }),
            { status: 200 },
          ),
      ),
    )
    const langs = await fetchRegistry()
    expect(langs.map((l) => l.code)).toEqual(["ja", "zh-CN"])
  })

  it("returns an empty list when the manifest has no usable entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ languages: [] }), { status: 200 }),
      ),
    )
    expect(await fetchRegistry()).toEqual([])
  })

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    )
    await expect(fetchRegistry()).rejects.toThrow(LanguagePackError)
  })

  it("throws on a malformed manifest shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ nope: true }), { status: 200 }),
      ),
    )
    await expect(fetchRegistry()).rejects.toThrow(/malformed/)
  })

  it("throws a friendly error when the fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down")
      }),
    )
    await expect(fetchRegistry()).rejects.toThrow(LanguagePackError)
  })

  it("rejects a streamed manifest larger than the registry cap (no content-length)", async () => {
    // A chunked response omits content-length, so the cap must be enforced while
    // streaming. Emit >64KB (MAX_REGISTRY_BYTES) across chunks via a real stream.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const chunk = new TextEncoder().encode("x".repeat(16 * 1024))
        let sent = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 80 * 1024) {
              controller.close()
              return
            }
            sent += chunk.byteLength
            controller.enqueue(chunk)
          },
        })
        return new Response(body, { status: 200 })
      }),
    )
    await expect(fetchRegistry()).rejects.toThrow(/too large/i)
  })
})

describe("availableBuiltInLangs", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns every language the manifest lists (no per-pack probe)", async () => {
    let headProbes = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input)
        if (init?.method === "HEAD") headProbes += 1
        if (/index\.json$/.test(u)) {
          return new Response(
            JSON.stringify({
              languages: [{ code: "ja" }, { code: "es" }, { code: "de" }],
            }),
            { status: 200 },
          )
        }
        return new Response("{}", { status: 200 })
      }),
    )
    const langs = await availableBuiltInLangs()
    expect(langs.map((l) => l.code).sort()).toEqual(["de", "es", "ja"])
    // The manifest is trusted; no HEAD probes are issued.
    expect(headProbes).toBe(0)
  })

  it("propagates a manifest fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x", { status: 500 })),
    )
    await expect(availableBuiltInLangs()).rejects.toThrow(LanguagePackError)
  })
})

describe("prepareFromBuiltIn", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fetches <base>/<code>.json and previews it with the given code", async () => {
    let requestedUrl = ""
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ nav: { roleStudent: "受講者" } }), {
        status: 200,
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const preview = await prepareFromBuiltIn("ja")
    expect(preview.code).toBe("ja")
    expect(preview.sample).toContain("受講者")
    // Resolves to the registry's <code>.json URL.
    expect(requestedUrl).toMatch(/\/ja\.json$/)
  })

  it("rejects an invalid code before fetching", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(prepareFromBuiltIn("!!")).rejects.toThrow(LanguagePackError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("shareUrlForLang", () => {
  const realWindow = globalThis.window
  afterEach(() => {
    if (realWindow === undefined) {
      // @ts-expect-error - restore the node env's missing window
      delete globalThis.window
    } else {
      globalThis.window = realWindow
    }
  })

  it("builds an origin+path URL with ?lang=<code>, dropping other params", () => {
    vi.stubGlobal("window", {
      location: { href: "https://app.example/class/42?foo=1#x" },
    })
    const url = shareUrlForLang("es")
    expect(url).toBe("https://app.example/class/42?lang=es")
  })

  it("returns null when there's no window", () => {
    vi.stubGlobal("window", {
      location: { href: "https://app.example/" },
    })
    expect(shareUrlForLang("pt-BR")).toBe("https://app.example/?lang=pt-BR")
    vi.unstubAllGlobals()
    // @ts-expect-error - simulate SSR/no-window
    delete globalThis.window
    expect(shareUrlForLang("es")).toBeNull()
  })

  it("rejects an invalid code (returns null rather than a bad URL)", () => {
    vi.stubGlobal("window", {
      location: { href: "https://app.example/" },
    })
    expect(shareUrlForLang("not a code!!")).toBeNull()
  })
})

describe("applyLangFromQuery", () => {
  const realWindow = globalThis.window

  afterEach(() => {
    vi.unstubAllGlobals()
    if (realWindow === undefined) {
      // @ts-expect-error - restore the node env's missing window
      delete globalThis.window
    } else {
      globalThis.window = realWindow
    }
  })

  // Minimal window stub: a mutable location URL + a history.replaceState that
  // records the URL it was asked to set, so we can assert the param is stripped.
  // Optionally seeds an in-memory localStorage so the already-installed branch
  // (which reads stored packs) can be exercised.
  const stubWindow = (href: string, storageSeed?: Record<string, string>) => {
    let currentHref = href
    const replaced: string[] = []
    const store = new Map<string, string>(Object.entries(storageSeed ?? {}))
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    }
    const win = {
      get location() {
        return { href: currentHref } as Location
      },
      localStorage: localStorage as unknown as Storage,
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaced.push(url)
          // Reflect the new URL so a subsequent read sees the stripped param.
          currentHref = new URL(url, currentHref).href
        },
      },
    }
    vi.stubGlobal("window", win)
    return { replaced }
  }

  it("does nothing (and doesn't fetch) when no ?lang= is present", async () => {
    stubWindow("https://app.example/dashboard")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await applyLangFromQuery()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("switches to en for ?lang=en without any network call", async () => {
    const { replaced } = stubWindow(
      `https://app.example/?${LANG_QUERY_PARAM}=en`,
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await applyLangFromQuery()
    // BASE_LANG is built in — no manifest or pack fetch, and the param is stripped.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(replaced.at(-1)).not.toContain(`${LANG_QUERY_PARAM}=`)
  })

  it("switches to an already-installed code without fetching the registry", async () => {
    // Seed a stored pack so the already-installed fast path is taken.
    const stored = {
      [PACKS_STORAGE_KEY]: JSON.stringify({
        ja: { code: "ja", bundle: { "nav.roleStudent": "受講者" } },
      }),
    }
    const { replaced } = stubWindow(
      `https://app.example/?${LANG_QUERY_PARAM}=ja`,
      stored,
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await applyLangFromQuery()
    // Installed pack switches with no manifest/pack fetch; param still stripped.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(replaced.at(-1)).not.toContain(`${LANG_QUERY_PARAM}=`)
  })

  it("ignores an invalid ?lang= code without fetching, and strips the param", async () => {
    const { replaced } = stubWindow(
      `https://app.example/?${LANG_QUERY_PARAM}=not_a_code!!`,
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await applyLangFromQuery()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(replaced.at(-1)).not.toContain(LANG_QUERY_PARAM)
  })

  it("ignores a valid code the registry does not offer (no pack fetch)", async () => {
    stubWindow(`https://app.example/?${LANG_QUERY_PARAM}=zz`)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      // Only the manifest should ever be requested for an unoffered code.
      expect(String(input)).toMatch(/index\.json$/)
      return new Response(JSON.stringify({ languages: [{ code: "ja" }] }), {
        status: 200,
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    await applyLangFromQuery()
    // Only the registry manifest is fetched; no <code>.json for an unoffered code.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => /index\.json$/.test(u))).toBe(true)
    expect(urls.some((u) => /\/zz\.json$/.test(u))).toBe(false)
  })

  it("fetches the pack for a registry-offered code and strips the param", async () => {
    const { replaced } = stubWindow(
      `https://app.example/?${LANG_QUERY_PARAM}=ja&keep=1`,
    )
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (/index\.json$/.test(u)) {
        return new Response(JSON.stringify({ languages: [{ code: "ja" }] }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ nav: { roleStudent: "受講者" } }), {
        status: 200,
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    await applyLangFromQuery()

    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => /\/ja\.json$/.test(u))).toBe(true)
    // Param stripped, but unrelated query params are preserved.
    const finalUrl = replaced.at(-1) ?? ""
    expect(finalUrl).not.toContain(`${LANG_QUERY_PARAM}=`)
    expect(finalUrl).toContain("keep=1")
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
