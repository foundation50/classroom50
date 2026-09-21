import type { Plugin } from "vite"

import { ANALYTICS_STORAGE_KEY } from "../src/types/preferences.ts"

// The single place analytics vendors are wired into the built page. Each
// provider is enabled by one VITE_* variable (mapped from repository variables
// by .github/actions/web-analytics-env) and injected only when that variable is
// set, so local, test, and self-hosted builds carry no tracking by default.
//
// Every provider's snippet runs inside one shared gate that skips it when the
// browser sends Global Privacy Control or Do Not Track, or when the visitor
// opted out in the app (the preferences registry stores the literal "off" under
// ANALYTICS_STORAGE_KEY). Injecting at build time rather than editing
// index.html keeps the source page free of third-party script and keeps its
// anti-flash drift tests valid.

export type AnalyticsEnv = Record<string, string | undefined>

type Provider = {
  name: string
  envVar: string
  // Shape of a valid value; a mismatch fails the build with `hint`.
  pattern: RegExp
  hint: string
  injectTo: "head" | "body-end"
  // JavaScript executed inside the shared gate. `id` is the validated value.
  script: (id: string) => string
}

const GTM_SRC = "https://www.googletagmanager.com/gtm.js"
const CF_BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js"

// Google's snippet verbatim, preceded by Consent Mode defaults: the gate has
// already established the visitor allows analytics, and advertising storage is
// denied outright because nothing here is an ad product. Google's noscript
// <iframe> is deliberately omitted: the app needs JavaScript anyway, and a
// noscript beacon could not honor the opt-out.
const gtmScript = (id: string) =>
  `window.dataLayer=window.dataLayer||[];` +
  `function gtag(){window.dataLayer.push(arguments)}` +
  `gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"granted"});` +
  `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});` +
  `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';` +
  `j.async=true;j.src=${JSON.stringify(GTM_SRC)}+'?id='+i+dl;f.parentNode.insertBefore(j,f);` +
  `})(window,document,'script','dataLayer',${JSON.stringify(id)});`

// Cloudflare's dashboard tag, created dynamically so it sits inside the gate.
// The beacon finds its config via `script[data-cf-beacon]`, so a dynamically
// added module script works.
const cloudflareScript = (token: string) =>
  `var s=document.createElement("script");s.type="module";` +
  `s.src=${JSON.stringify(CF_BEACON_SRC)};` +
  `s.setAttribute("data-cf-beacon",${JSON.stringify(`{"token": "${token}"}`)});` +
  `document.body.appendChild(s);`

export const ANALYTICS_PROVIDERS: readonly Provider[] = [
  {
    name: "Google Tag Manager",
    envVar: "VITE_GTM_CONTAINER_ID",
    pattern: /^GTM-[A-Z0-9]+$/,
    hint: "the container ID from the Google Tag Manager snippet, such as GTM-ABC123",
    injectTo: "head",
    script: gtmScript,
  },
  {
    name: "Cloudflare Web Analytics",
    envVar: "VITE_CF_BEACON_TOKEN",
    pattern: /^[A-Za-z0-9_-]+$/,
    hint: "only the token value from the Cloudflare Web Analytics snippet, not the whole <script> tag",
    injectTo: "body-end",
    script: cloudflareScript,
  },
]

// Wrapped in an IIFE like the anti-flash scripts so nothing leaks onto window.
// localStorage access throws in some hardened/private modes; treat that as no
// opt-out rather than crashing before the app boots.
function gated(body: string): string {
  return (
    `(function(){var off=false;` +
    `try{off=localStorage.getItem(${JSON.stringify(ANALYTICS_STORAGE_KEY)})==="off"}catch(e){}` +
    `if(navigator.globalPrivacyControl!==true&&navigator.doNotTrack!=="1"&&!off){${body}}})()`
  )
}

function snippet(provider: Provider, id: string): string {
  return (
    `<!-- ${provider.name} --><script>${gated(provider.script(id))}</script>` +
    `<!-- End ${provider.name} -->`
  )
}

// Inserts `markup` on its own line before the closing tag, matching its indent.
function insertBefore(
  html: string,
  closingTag: string,
  markup: string,
): string {
  return html.replace(
    new RegExp(`^([ \\t]*)${closingTag}`, "m"),
    (close, indent: string) => `${indent}  ${markup}\n${close}`,
  )
}

export function analyticsPlugin(env: AnalyticsEnv): Plugin {
  const enabled = ANALYTICS_PROVIDERS.flatMap((provider) => {
    const id = env[provider.envVar]
    if (!id) return []
    if (!provider.pattern.test(id)) {
      throw new Error(`${provider.envVar} must be ${provider.hint}`)
    }
    return [{ provider, id }]
  })
  return {
    name: "classroom50:analytics",
    transformIndexHtml(html) {
      return enabled.reduce((page, { provider, id }) => {
        const closing = provider.injectTo === "head" ? "</head>" : "</body>"
        return insertBefore(page, closing, snippet(provider, id))
      }, html)
    },
  }
}
