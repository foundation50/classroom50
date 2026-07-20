import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "i18next"
import { initReactI18next } from "react-i18next"

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
  hashBundle,
  inferLangCode,
  installPack,
  missingKeys,
  normalizeLangCode,
  packSources,
  parseBundle,
  prepareFromBuiltIn,
  prepareFromUrl,
  refreshInstalledPacks,
  resetRegistryCache,
  resolveStartupLang,
  shareUrlForLang,
  subscribeToPackUpdates,
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

  // <Trans> merges attributes from pack-controlled marker tags onto the mapped
  // component (pack side wins), so an attribute-bearing tag in a hostile pack
  // can repoint a trusted link's href. Bare markers only.
  it("rejects markup tags carrying attributes", () => {
    for (const hostile of [
      '{"k":"click <repoLink href=\\"https://evil.example\\">here</repoLink>"}',
      '{"k":"x <a title=\\"t\\">y</a>"}',
      '{"k":"x <span onmouseover=x>y</span>"}',
      // Slash-separated attribute: html-parse-stringify treats `/` as an
      // attribute separator and extracts a clean href, so this must be rejected
      // even though there's no space between the tag name and the attribute.
      '{"k":"click <repoLink/ href=\\"https://evil.example\\">here</repoLink>"}',
      '{"k":"x <br/ href=\\"https://evil.example\\">y"}',
      // Whitespace other than a space (newline/tab) between name and attribute.
      '{"k":"x <a\\nhref=\\"https://evil.example\\">y</a>"}',
      '{"k":"x <a\\thref=\\"https://evil.example\\">y</a>"}',
      // A hostile attribute tag following a legitimate bare marker in the same
      // value must still be caught.
      '{"k":"<repo>{{repo}}</repo> <a href=\\"https://evil.example\\">x</a>"}',
    ]) {
      expect(() => parseBundle(hostile)).toThrow(/attributes/)
    }
  })

  it("accepts bare markers including spaced self-closing tags", () => {
    expect(
      parseBundle('{"k":"No PR for <repo>{{repo}}</repo> yet <br />"}'),
    ).toEqual({ k: "No PR for <repo>{{repo}}</repo> yet <br />" })
  })

  it("accepts non-markup angle brackets and adjacent bare markers", () => {
    // "<owner>/<repo>" is two bare marker tags; "< 1 day" is not a tag at all.
    expect(
      parseBundle(
        '{"a":"<owner>{{owner}}</owner>/<repo>{{repo}}</repo>","b":"less than < 1 day"}',
      ),
    ).toEqual({
      a: "<owner>{{owner}}</owner>/<repo>{{repo}}</repo>",
      b: "less than < 1 day",
    })
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

  it("rejects http when requireHttps is set (silent auto-refresh path)", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      prepareFromUrl("http://example.com/de.json", "de", {
        requireHttps: true,
      }),
    ).rejects.toThrow(/https/)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
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
    resetRegistryCache()
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
    resetRegistryCache()
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
    resetRegistryCache()
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
    resetRegistryCache()
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

describe("fetchRegistry memoization", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetRegistryCache()
  })

  it("dedupes two near-simultaneous calls into one fetch", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ languages: [{ code: "ja" }] }), {
          status: 200,
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const [a, b] = await Promise.all([fetchRegistry(), fetchRegistry()])
    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("serves a cached result within the TTL, then refetches after reset", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ languages: [{ code: "ja" }] }), {
          status: 200,
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await fetchRegistry()
    await fetchRegistry()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resetRegistryCache()
    await fetchRegistry()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failure (a later call retries)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ languages: [{ code: "ja" }] }), {
          status: 200,
        }),
      )
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchRegistry()).rejects.toThrow(LanguagePackError)
    const langs = await fetchRegistry()
    expect(langs.map((l) => l.code)).toEqual(["ja"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("hashBundle", () => {
  it("is order-independent and value-sensitive", () => {
    expect(hashBundle({ a: "1", b: "2" })).toBe(hashBundle({ b: "2", a: "1" }))
    expect(hashBundle({ a: "1" })).not.toBe(hashBundle({ a: "2" }))
  })
})

describe("refreshInstalledPacks", () => {
  const realWindow = globalThis.window

  beforeEach(async () => {
    // installPack -> i18next.addResourceBundle throws pre-init; these tests
    // import only ./customLocale, so init a minimal instance first.
    if (!i18n.isInitialized) {
      await i18n.use(initReactI18next).init({
        lng: "en",
        fallbackLng: "en",
        resources: { en: { translation: {} } },
        interpolation: { escapeValue: false },
      })
    }
    // Drain codes buffered by a prior test (buffer is module state).
    subscribeToPackUpdates(() => {})()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetRegistryCache()
    if (realWindow === undefined) {
      // @ts-expect-error - restore the node env's missing window
      delete globalThis.window
    } else {
      globalThis.window = realWindow
    }
  })

  // In-memory localStorage-backed window so installPack/readStoredPacks work.
  // Returns the live store so tests can read back what was persisted.
  const stubWindow = (storageSeed?: Record<string, string>) => {
    const store = new Map<string, string>(Object.entries(storageSeed ?? {}))
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    }
    vi.stubGlobal("window", {
      localStorage: localStorage as unknown as Storage,
    })
    return store
  }

  const readPacks = (store: Map<string, string>) =>
    JSON.parse(store.get(PACKS_STORAGE_KEY) ?? "{}") as Record<
      string,
      { code: string; bundle: Record<string, string>; source?: string }
    >

  const httpsRegistry = "https://fifty.foundation/classroom50-language-packs"

  it("overwrites a registry pack when the manifest version is newer", async () => {
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "alt" },
        },
      }),
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (/index\.json$/.test(u)) {
        return new Response(
          JSON.stringify({ languages: [{ code: "de", version: "2" }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ nav: { roleStudent: "Studentin" } }),
        {
          status: 200,
        },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const updated = await refreshInstalledPacks()
    expect(updated).toEqual(["de"])
    const packs = readPacks(store)
    expect(packs.de.bundle["nav.roleStudent"]).toBe("Studentin")
    // The pack URL must be the https registry origin (silent path is https-only).
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(
      urls.some((u) => u.startsWith(httpsRegistry) && /\/de\.json$/.test(u)),
    ).toBe(true)
  })

  it("preserves an unknown pack field across a read-modify-write", async () => {
    // A field written by a newer release (packSchema is .loose()) must survive
    // an older release rewriting the store, so forward-compat data isn't lost.
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "user",
          bundle: { "nav.roleStudent": "Studentin" },
          futureField: { note: "written by a newer release" },
        },
      }),
    })
    // installPack does a read-modify-write of the whole store (here via a
    // no-op install of a second pack), which must not strip de's unknown field.
    installPack("fr", { "nav.roleStudent": "Étudiante" })
    const packs = readPacks(store) as Record<string, { futureField?: unknown }>
    expect(packs.de.futureField).toEqual({ note: "written by a newer release" })
  })

  it("leaves a user-sourced pack untouched even when its code is in the registry", async () => {
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "user",
          bundle: { "nav.roleStudent": "mine" },
        },
      }),
    })
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ languages: [{ code: "de", version: "9" }] }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const updated = await refreshInstalledPacks()
    expect(updated).toEqual([])
    // No registry-eligible packs, so the manifest is never even fetched.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readPacks(store).de.bundle["nav.roleStudent"]).toBe("mine")
  })

  it("treats a legacy pack with no source as user (not refreshed)", async () => {
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: { code: "de", bundle: { "nav.roleStudent": "legacy" } },
      }),
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const updated = await refreshInstalledPacks()
    expect(updated).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readPacks(store).de.bundle["nav.roleStudent"]).toBe("legacy")
  })

  it("keeps the pack when the registry is unreachable", async () => {
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "keep" },
        },
      }),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline")
      }),
    )
    const updated = await refreshInstalledPacks()
    expect(updated).toEqual([])
    expect(readPacks(store).de.bundle["nav.roleStudent"]).toBe("keep")
  })

  it("does not abort the batch when a single pack fetch fails", async () => {
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "de-old" },
        },
        fr: {
          code: "fr",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "fr-old" },
        },
      }),
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (/index\.json$/.test(u)) {
        return new Response(
          JSON.stringify({
            languages: [
              { code: "de", version: "2" },
              { code: "fr", version: "2" },
            ],
          }),
          { status: 200 },
        )
      }
      if (/\/de\.json$/.test(u)) {
        return new Response("boom", { status: 500 })
      }
      return new Response(JSON.stringify({ nav: { roleStudent: "fr-new" } }), {
        status: 200,
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const updated = await refreshInstalledPacks()
    expect(updated).toEqual(["fr"])
    const packs = readPacks(store)
    expect(packs.de.bundle["nav.roleStudent"]).toBe("de-old") // untouched
    expect(packs.fr.bundle["nav.roleStudent"]).toBe("fr-new") // updated
  })

  it("does not resurrect a pack removed by another tab during the fetch", async () => {
    const store = stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "old" },
        },
      }),
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (/index\.json$/.test(u)) {
        return new Response(
          JSON.stringify({ languages: [{ code: "de", version: "2" }] }),
          { status: 200 },
        )
      }
      // Simulate another tab removing the pack while this pack fetch is in
      // flight: mutate the backing store before refreshInstalledPacks persists.
      store.delete(PACKS_STORAGE_KEY)
      return new Response(JSON.stringify({ nav: { roleStudent: "neu" } }), {
        status: 200,
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const updated = await refreshInstalledPacks()
    // The pack was removed mid-fetch, so it must stay gone (not re-added) and
    // must not be reported as updated.
    expect(updated).toEqual([])
    expect(readPacks(store).de).toBeUndefined()
  })

  it("skips the fetch entirely when the version is unchanged", async () => {
    stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "3",
          bundle: { "nav.roleStudent": "same" },
        },
      }),
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (/index\.json$/.test(u)) {
        return new Response(
          JSON.stringify({ languages: [{ code: "de", version: "3" }] }),
          { status: 200 },
        )
      }
      throw new Error("should not fetch the pack when version is unchanged")
    })
    vi.stubGlobal("fetch", fetchMock)

    const updated = await refreshInstalledPacks()
    expect(updated).toEqual([])
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => /\/de\.json$/.test(u))).toBe(false)
  })

  it("emits updated codes to subscribers", async () => {
    stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "old" },
        },
      }),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input)
        if (/index\.json$/.test(u)) {
          return new Response(
            JSON.stringify({ languages: [{ code: "de", version: "2" }] }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ nav: { roleStudent: "neu" } }), {
          status: 200,
        })
      }),
    )

    const seen: string[][] = []
    const unsubscribe = subscribeToPackUpdates((codes) => seen.push(codes))
    await refreshInstalledPacks()
    unsubscribe()
    expect(seen).toEqual([["de"]])
  })

  it("buffers updates emitted before any subscriber and flushes them on first subscribe", async () => {
    stubWindow({
      [PACKS_STORAGE_KEY]: JSON.stringify({
        de: {
          code: "de",
          source: "registry",
          version: "1",
          bundle: { "nav.roleStudent": "old" },
        },
      }),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input)
        if (/index\.json$/.test(u)) {
          return new Response(
            JSON.stringify({ languages: [{ code: "de", version: "2" }] }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ nav: { roleStudent: "neu" } }), {
          status: 200,
        })
      }),
    )

    // Startup path: the refresh runs before the toaster mounts, so the update
    // is emitted with no listener and must be buffered.
    const updated = await refreshInstalledPacks()
    expect(updated).toEqual(["de"])

    // First subscriber (the mounting toaster) drains the buffer exactly once.
    const seen: string[][] = []
    const unsubscribe = subscribeToPackUpdates((codes) => seen.push(codes))
    expect(seen).toEqual([["de"]])
    unsubscribe()

    // A later subscriber gets nothing — the buffer was already drained.
    const seenLater: string[][] = []
    subscribeToPackUpdates((codes) => seenLater.push(codes))()
    expect(seenLater).toEqual([])
  })
})

describe("packSources", () => {
  let realWindow: (Window & typeof globalThis) | undefined

  beforeEach(() => {
    realWindow = globalThis.window
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (realWindow === undefined) {
      // @ts-expect-error - restore the node env's missing window
      delete globalThis.window
    } else {
      globalThis.window = realWindow
    }
  })

  const stubStore = (packs: Record<string, unknown>) => {
    const store = new Map([[PACKS_STORAGE_KEY, JSON.stringify(packs)]])
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: () => {},
        removeItem: () => {},
      } as unknown as Storage,
    })
  }

  it("maps each stored pack to its source, defaulting legacy packs to user", () => {
    stubStore({
      de: {
        code: "de",
        source: "registry",
        bundle: { "nav.roleStudent": "x" },
      },
      fr: { code: "fr", source: "user", bundle: { "nav.roleStudent": "y" } },
      // Legacy pack with no source field must read as "user" (the badge sentinel).
      es: { code: "es", bundle: { "nav.roleStudent": "z" } },
    })
    expect(packSources()).toEqual({ de: "registry", fr: "user", es: "user" })
  })

  it("returns an empty map when no packs are stored", () => {
    stubStore({})
    expect(packSources()).toEqual({})
  })
})

describe("resolveStartupLang", () => {
  // Direction seeding at startup (i18n/index.ts) reads this BEFORE the
  // changeLanguage chain runs; these cases pin the contract that the seed and
  // the chain agree on which language actually activates.
  it("returns the stored language when its pack is installed", () => {
    expect(resolveStartupLang("ar", ["ar", "de"])).toBe("ar")
  })

  it("falls back to the base language when the stored pack is gone", () => {
    // Persisted-but-uninstalled: the anti-flash script guessed rtl from the
    // stale stored code, but the UI will render English — ltr is correct.
    expect(resolveStartupLang("ar", [])).toBe("en")
    expect(resolveStartupLang("he", ["de"])).toBe("en")
  })

  it("returns the base language for a stored base-language choice", () => {
    expect(resolveStartupLang("en", ["ar"])).toBe("en")
  })
})
