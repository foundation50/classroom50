import { describe, expect, it } from "vitest"

import { ANALYTICS_STORAGE_KEY } from "../src/types/preferences.ts"
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

function transform(env: Record<string, string | undefined>): string {
  const plugin = analyticsPlugin(env)
  const hook = plugin.transformIndexHtml as (html: string) => string
  return hook(PAGE)
}

function scriptOf(html: string, providerName: string): string {
  const match = html.match(
    new RegExp(
      `<!-- ${providerName} --><script>([\\s\\S]*?)</script><!-- End ${providerName} -->`,
    ),
  )
  if (!match) throw new Error(`${providerName} snippet not found`)
  return match[1]
}

// Runs a generated snippet against minimal fakes and reports what it did.
function execute(
  code: string,
  {
    stored = null,
    gpc,
    dnt = "0",
  }: { stored?: string | null | "THROW"; gpc?: boolean; dnt?: string } = {},
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
    getItem() {
      if (stored === "THROW") throw new Error("blocked")
      return stored
    },
  }
  new Function("window", "document", "navigator", "localStorage", code)(
    win,
    document,
    { globalPrivacyControl: gpc, doNotTrack: dnt },
    localStorage,
  )
  return { inserted, win }
}

describe("analyticsPlugin", () => {
  it("leaves the page untouched when no provider variable is set", () => {
    expect(transform({})).toBe(PAGE)
  })

  it("injects GTM at the end of <head> and Cloudflare at the end of <body>", () => {
    const html = transform({
      VITE_GTM_CONTAINER_ID: "GTM-ABC123",
      VITE_CF_BEACON_TOKEN: "abc",
    })
    const head = html.slice(0, html.indexOf("</head>"))
    const body = html.slice(html.indexOf("<body>"))
    expect(head).toContain("<!-- Google Tag Manager -->")
    expect(head.indexOf("/* anti-flash */")).toBeLessThan(
      head.indexOf("<!-- Google Tag Manager -->"),
    )
    expect(body).toContain("<!-- Cloudflare Web Analytics -->")
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

  describe.each(
    ANALYTICS_PROVIDERS.map((p) => ({
      name: p.name,
      env: { [p.envVar]: p.envVar.includes("GTM") ? "GTM-ABC123" : "abc" },
    })),
  )("$name gate", ({ name, env }) => {
    const code = scriptOf(transform(env), name)

    it("loads by default and when the preference is on", () => {
      expect(execute(code).inserted).toHaveLength(1)
      expect(execute(code, { stored: "on" }).inserted).toHaveLength(1)
    })

    it("does not load for the in-app opt-out, GPC, or DNT", () => {
      expect(execute(code, { stored: "off" }).inserted).toHaveLength(0)
      expect(execute(code, { gpc: true }).inserted).toHaveLength(0)
      expect(execute(code, { dnt: "1" }).inserted).toHaveLength(0)
    })

    it("treats a throwing localStorage as no opt-out", () => {
      expect(execute(code, { stored: "THROW" }).inserted).toHaveLength(1)
    })

    it("leaks nothing onto window except what the vendor needs", () => {
      const { win } = execute(code)
      const allowed = new Set(["dataLayer"])
      expect(Object.keys(win).filter((k) => !allowed.has(k))).toEqual([])
    })
  })

  it("reads the opt-out from the registry's storage key", () => {
    const code = scriptOf(
      transform({ VITE_CF_BEACON_TOKEN: "abc" }),
      "Cloudflare Web Analytics",
    )
    expect(code).toContain(JSON.stringify(ANALYTICS_STORAGE_KEY))
  })

  it("sets Google Consent Mode defaults before loading the container", () => {
    const { inserted, win } = execute(
      scriptOf(
        transform({ VITE_GTM_CONTAINER_ID: "GTM-ABC123" }),
        "Google Tag Manager",
      ),
    )
    const dataLayer = win.dataLayer as unknown[]
    const consent = dataLayer[0] as IArguments
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
    const { inserted } = execute(
      scriptOf(
        transform({ VITE_CF_BEACON_TOKEN: "abc" }),
        "Cloudflare Web Analytics",
      ),
    )
    expect(inserted[0]).toMatchObject({
      type: "module",
      src: "https://static.cloudflareinsights.com/beacon.min.js",
      "data-cf-beacon": '{"token": "abc"}',
    })
  })
})
