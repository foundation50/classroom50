import { describe, expect, it } from "vitest"

import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
} from "../src/types/consent.ts"
import {
  ANALYTICS_PROVIDERS,
  ANALYTICS_RUNTIME_GLOBAL,
  analyticsPlugin,
} from "./analytics.ts"

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

const granted = {
  [CONSENT_STORAGE_KEY]: JSON.stringify({
    v: CONSENT_VERSION,
    at: "t",
    analytics: true,
  }),
}
const denied = {
  [CONSENT_STORAGE_KEY]: JSON.stringify({
    v: CONSENT_VERSION,
    at: "t",
    analytics: false,
  }),
}

describe("analyticsPlugin", () => {
  it("leaves the page untouched when no provider variable is set", () => {
    expect(transform({})).toBe(PAGE)
  })

  it("injects the runtime first in <head>, GTM after it, and Cloudflare at the end of <body>", () => {
    const html = transform(BOTH)
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

  it("every provider declares a consent category", () => {
    expect(ANALYTICS_PROVIDERS.every((p) => p.category === "analytics")).toBe(
      true,
    )
  })

  describe("consent gate at boot", () => {
    const html = transform(BOTH)

    it("loads nothing without a decision", () => {
      expect(boot(html).inserted).toHaveLength(0)
      expect(boot(html, { storage: "THROW" }).inserted).toHaveLength(0)
    })

    it("loads nothing when analytics was denied or the record is from an older version", () => {
      expect(boot(html, { storage: denied }).inserted).toHaveLength(0)
      const old = {
        [CONSENT_STORAGE_KEY]: JSON.stringify({
          v: 0,
          at: "t",
          analytics: true,
        }),
      }
      expect(boot(html, { storage: old }).inserted).toHaveLength(0)
    })

    it("honors the pre-consent opt-out as a denial", () => {
      const legacy = { [LEGACY_ANALYTICS_STORAGE_KEY]: "off" }
      expect(boot(html, { storage: legacy }).inserted).toHaveLength(0)
    })

    it("loads every analytics vendor when analytics was granted", () => {
      expect(boot(html, { storage: granted }).inserted).toHaveLength(2)
    })

    it("never loads while the browser sends GPC or DNT, even with consent", () => {
      expect(boot(html, { storage: granted, gpc: true }).inserted).toHaveLength(
        0,
      )
      expect(boot(html, { storage: granted, dnt: "1" }).inserted).toHaveLength(
        0,
      )
    })
  })

  describe("runtime bridge for the app", () => {
    const html = transform(BOTH)

    it("enable() starts granted categories once, and reports them as started", () => {
      const { inserted, runtime } = boot(html)
      expect(runtime.started("analytics")).toBe(false)
      runtime.enable(["analytics"])
      runtime.enable(["analytics"])
      expect(inserted).toHaveLength(2)
      expect(runtime.started("analytics")).toBe(true)
    })

    it("enable() is a no-op under GPC", () => {
      const { inserted, runtime } = boot(html, { gpc: true })
      runtime.enable(["analytics"])
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
