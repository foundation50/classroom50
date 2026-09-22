import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  ANALYTICS_RUNTIME_GLOBAL,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
} from "../src/types/consent.ts"
import { ANALYTICS_PROVIDERS, analyticsPlugin } from "./analytics.ts"

const PAGE = `<!doctype html>
<html>
  <head>
    <script>/* anti-flash */</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const BOTH = {
  VITE_GTM_CONTAINER_ID: "GTM-ABC123",
  VITE_CF_BEACON_TOKEN: "abc",
}

function transform(env: Record<string, string | undefined>): string {
  const plugin = analyticsPlugin(env)
  const hook = plugin.transformIndexHtml as (html: string) => string
  return hook(PAGE)
}

// Every injected inline script, in document order.
function scriptsOf(html: string): string[] {
  return [
    ...html.matchAll(/<!-- (?!End )[^>]+ --><script>([\s\S]*?)<\/script>/g),
  ].map((m) => m[1])
}

type Runtime = {
  enable: (categories: string[]) => void
  started: (category: string) => boolean
}

// Boots a fake page: runs the injected scripts in order against minimal DOM,
// storage, and navigator fakes, and reports what was inserted.
function boot(
  html: string,
  {
    storage = {},
    gpc,
    dnt = "0",
  }: {
    storage?: Record<string, string> | "THROW"
    gpc?: boolean
    dnt?: string
  } = {},
) {
  const inserted: Record<string, unknown>[] = []
  const win: Record<string, unknown> = {}
  const element = () => {
    const el: Record<string, unknown> = {
      setAttribute(k: string, v: string) {
        el[k] = v
      },
    }
    return el
  }
  const document = {
    createElement: element,
    getElementsByTagName: () => [
      {
        parentNode: {
          insertBefore: (j: Record<string, unknown>) => inserted.push(j),
        },
      },
    ],
    body: { appendChild: (j: Record<string, unknown>) => inserted.push(j) },
  }
  const localStorage = {
    getItem(key: string) {
      if (storage === "THROW") throw new Error("blocked")
      return storage[key] ?? null
    },
  }
  for (const code of scriptsOf(html)) {
    new Function("window", "document", "navigator", "localStorage", code)(
      win,
      document,
      { globalPrivacyControl: gpc, doNotTrack: dnt },
      localStorage,
    )
  }
  return { inserted, win, runtime: win[ANALYTICS_RUNTIME_GLOBAL] as Runtime }
}

// A stored consent record, as the app writes it.
const stored = (
  choices: Record<string, boolean>,
  v: number = CONSENT_VERSION,
) => ({
  [CONSENT_STORAGE_KEY]: JSON.stringify({ v, at: "t", ...choices }),
})
const granted = stored({ cloudflare: true, google: true })
const denied = stored({ cloudflare: false, google: false })

describe("analyticsPlugin", () => {
  const page = transform(BOTH)

  it("leaves the page untouched when no provider variable is set", () => {
    expect(transform({})).toBe(PAGE)
  })

  it("injects only the consent runtime for the dev server with no vendor", () => {
    const html = (
      analyticsPlugin({}, true).transformIndexHtml as (html: string) => string
    )(PAGE)
    expect(html).toContain("<!-- Analytics consent runtime -->")
    expect(html).not.toContain("<!-- Google Tag Manager -->")
    expect(html).not.toContain("<!-- Cloudflare Web Analytics -->")
    expect(boot(html).runtime.started("google")).toBe(false)
  })

  // .github/actions/web-analytics-env/action.yaml lists one row per vendor by
  // hand; a vendor added on one side only would ship silently off.
  it("the deploy action maps exactly the variables the providers read", () => {
    const action = readFileSync(
      fileURLToPath(
        new URL(
          "../../.github/actions/web-analytics-env/action.yaml",
          import.meta.url,
        ),
      ),
      "utf8",
    )
    const rows = [...action.matchAll(/^\s*"([^"|]+)\|([^"|]+)\|([^"|]+)"$/gm)]
    expect(rows.map((r) => r[2]).sort()).toEqual(
      ANALYTICS_PROVIDERS.map((p) => p.envVar).sort(),
    )
    for (const [, , buildVar, repoVar] of rows) expect(repoVar).toBe(buildVar)
  })

  it("injects the runtime first in <head>, GTM after it, and Cloudflare at the end of <body>", () => {
    const html = page
    const head = html.slice(0, html.indexOf("</head>"))
    const body = html.slice(html.indexOf("<body>"))
    expect(head.indexOf("/* anti-flash */")).toBeLessThan(
      head.indexOf("<!-- Analytics consent runtime -->"),
    )
    expect(head.indexOf("<!-- Analytics consent runtime -->")).toBeLessThan(
      head.indexOf("<!-- Google Tag Manager -->"),
    )
    expect(body.indexOf("/src/main.tsx")).toBeLessThan(
      body.indexOf("<!-- Cloudflare Web Analytics -->"),
    )
    expect(html).toMatch(/\n {4}<!-- Google Tag Manager -->/)
    expect(html).toMatch(/\n {4}<!-- Cloudflare Web Analytics -->/)
  })

  it("fails the build with the variable name when a value is malformed", () => {
    expect(() => analyticsPlugin({ VITE_GTM_CONTAINER_ID: "abc" })).toThrow(
      /VITE_GTM_CONTAINER_ID must be/,
    )
    expect(() =>
      analyticsPlugin({ VITE_CF_BEACON_TOKEN: '<script src="x">' }),
    ).toThrow(/VITE_CF_BEACON_TOKEN must be/)
  })

  it("each vendor has its own optional consent category", () => {
    const byName = Object.fromEntries(
      ANALYTICS_PROVIDERS.map((p) => [p.name, p.category]),
    )
    expect(byName).toEqual({
      "Google Tag Manager": "google",
      "Cloudflare Web Analytics": "cloudflare",
    })
  })

  describe("consent gate at boot", () => {
    const html = page
    const kinds = (inserted: Record<string, unknown>[]) =>
      inserted.map((i) => (i.type === "module" ? "cloudflare" : "google"))

    it("starts nothing without a decision", () => {
      expect(boot(html).inserted).toHaveLength(0)
      expect(boot(html, { storage: "THROW" }).inserted).toHaveLength(0)
    })

    it("starts nothing when everything was declined or the record is from an older version", () => {
      expect(boot(html, { storage: denied }).inserted).toHaveLength(0)
      const old = stored({ cloudflare: true, google: true }, 0)
      expect(boot(html, { storage: old }).inserted).toHaveLength(0)
    })

    it("honors the pre-consent opt-out as a denial", () => {
      const legacy = { [LEGACY_ANALYTICS_STORAGE_KEY]: "off" }
      expect(boot(html, { storage: legacy }).inserted).toHaveLength(0)
    })

    it("starts exactly the granted vendors", () => {
      expect(kinds(boot(html, { storage: granted }).inserted).sort()).toEqual([
        "cloudflare",
        "google",
      ])
      expect(
        kinds(
          boot(html, { storage: stored({ cloudflare: true, google: false }) })
            .inserted,
        ),
      ).toEqual(["cloudflare"])
    })

    it("starts nothing while the browser sends GPC or DNT, even with consent", () => {
      expect(boot(html, { storage: granted, gpc: true }).inserted).toHaveLength(
        0,
      )
      expect(boot(html, { storage: granted, dnt: "1" }).inserted).toHaveLength(
        0,
      )
    })
  })

  describe("runtime bridge for the app", () => {
    const html = page

    it("enable() starts granted categories once, and reports them as started", () => {
      const { inserted, runtime } = boot(html)
      expect(runtime.started("google")).toBe(false)
      runtime.enable(["google"])
      runtime.enable(["google"])
      expect(inserted).toHaveLength(1)
      expect(runtime.started("google")).toBe(true)
      runtime.enable(["cloudflare"])
      expect(inserted).toHaveLength(2)
    })

    it("enable() is a no-op under GPC", () => {
      const { inserted, runtime } = boot(html, { gpc: true })
      runtime.enable(["google", "cloudflare"])
      expect(inserted).toHaveLength(0)
    })

    it("ignores unknown categories", () => {
      const { inserted, runtime } = boot(html)
      runtime.enable(["marketing"])
      expect(inserted).toHaveLength(0)
    })

    it("leaks nothing onto window except the runtime and what vendors need", () => {
      const { win } = boot(html, { storage: granted })
      const allowed = new Set([ANALYTICS_RUNTIME_GLOBAL, "dataLayer"])
      expect(Object.keys(win).filter((k) => !allowed.has(k))).toEqual([])
    })
  })

  it("sets Google Consent Mode defaults before loading the container", () => {
    const { inserted, win } = boot(
      transform({ VITE_GTM_CONTAINER_ID: "GTM-ABC123" }),
      { storage: granted },
    )
    const consent = (win.dataLayer as unknown[])[0] as IArguments
    expect(Array.from(consent)).toEqual([
      "consent",
      "default",
      {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "granted",
      },
    ])
    expect(inserted[0]).toMatchObject({
      async: true,
      src: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
    })
  })

  it("loads the Cloudflare beacon as a module with the dashboard config shape", () => {
    const { inserted } = boot(transform({ VITE_CF_BEACON_TOKEN: "abc" }), {
      storage: granted,
    })
    expect(inserted[0]).toMatchObject({
      type: "module",
      src: "https://static.cloudflareinsights.com/beacon.min.js",
      "data-cf-beacon": '{"token": "abc"}',
    })
  })
})
