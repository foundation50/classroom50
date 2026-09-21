import type { Plugin } from "vite"

import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
  type OptionalConsentCategory,
} from "../src/types/consent.ts"

// The single place analytics vendors are wired into the built page. Each
// provider is enabled by one VITE_* variable (mapped from repository variables
// by .github/actions/web-analytics-env) and injected only when that variable is
// set, so local, test, and self-hosted builds carry no tracking by default.
//
// Nothing loads without consent. The injected runtime
// (window.__classroom50Analytics) registers each vendor under its consent
// category and starts it only when the stored consent record grants that
// category or the visitor accepts in the consent prompt (the app calls
// `enable`). Nothing starts while the browser sends Global Privacy Control or
// Do Not Track. Injecting at build time rather than editing index.html keeps
// the source page free of third-party script and its anti-flash drift tests
// valid.

export type AnalyticsEnv = Record<string, string | undefined>

type Provider = {
  name: string
  envVar: string
  category: OptionalConsentCategory
  // Shape of a valid value; a mismatch fails the build with `hint`.
  pattern: RegExp
  hint: string
  injectTo: "head" | "body-end"
  // JavaScript that starts the vendor. `id` is the validated value.
  script: (id: string) => string
}

export const ANALYTICS_RUNTIME_GLOBAL = "__classroom50Analytics"

const GTM_SRC = "https://www.googletagmanager.com/gtm.js"
const CF_BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js"

// Google's snippet verbatim, preceded by Consent Mode defaults: this runs only
// once the visitor granted analytics, and advertising storage is denied
// outright because nothing here is an ad product. Google's noscript <iframe>
// is deliberately omitted: the app needs JavaScript anyway, and a noscript
// beacon could not honor consent.
const gtmScript = (id: string) =>
  `window.dataLayer=window.dataLayer||[];` +
  `function gtag(){window.dataLayer.push(arguments)}` +
  `gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"granted"});` +
  `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});` +
  `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';` +
  `j.async=true;j.src=${JSON.stringify(GTM_SRC)}+'?id='+i+dl;f.parentNode.insertBefore(j,f);` +
  `})(window,document,'script','dataLayer',${JSON.stringify(id)});`

// Cloudflare's dashboard tag, created dynamically so it can wait for consent.
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
    category: "google",
    pattern: /^GTM-[A-Z0-9]+$/,
    hint: "the container ID from the Google Tag Manager snippet, such as GTM-ABC123",
    injectTo: "head",
    script: gtmScript,
  },
  {
    name: "Cloudflare Web Analytics",
    envVar: "VITE_CF_BEACON_TOKEN",
    category: "cloudflare",
    pattern: /^[A-Za-z0-9_-]+$/,
    hint: "only the token value from the Cloudflare Web Analytics snippet, not the whole <script> tag",
    injectTo: "body-end",
    script: cloudflareScript,
  },
]

// The consent runtime, injected once ahead of any vendor. `granted()` mirrors
// readConsent() in src/lib/consent.ts (current version, or the legacy opt-out
// as a denial); keep the two in step. Storage access throws in some hardened
// modes; that reads as "no decision", so nothing loads.
function runtimeScript(): string {
  const g = `window.${ANALYTICS_RUNTIME_GLOBAL}`
  return (
    `${g}=${g}||(function(){var loaders={},started={};` +
    `function blocked(){return navigator.globalPrivacyControl===true||navigator.doNotTrack==="1"}` +
    `function granted(){try{var raw=localStorage.getItem(${JSON.stringify(CONSENT_STORAGE_KEY)});` +
    `if(raw){var c=JSON.parse(raw);if(c&&c.v===${CONSENT_VERSION}){return c}}` +
    `if(localStorage.getItem(${JSON.stringify(LEGACY_ANALYTICS_STORAGE_KEY)})==="off"){return {}}}catch(e){}return null}` +
    `function run(fn){try{fn()}catch(e){}}` +
    `function enable(categories){if(blocked())return;for(var i=0;i<categories.length;i++){var c=categories[i];` +
    `if(started[c])continue;started[c]=true;var fns=loaders[c]||[];for(var j=0;j<fns.length;j++){run(fns[j])}}}` +
    // A vendor registering into an already started category (the runtime sits in
    // <head>; vendors may register from the end of <body>) starts right away.
    `return {register:function(category,fn){(loaders[category]=loaders[category]||[]).push(fn);` +
    `if(started[category]){if(!blocked())run(fn);return}` +
    `var c=granted();if(c&&c[category]===true)enable([category])},` +
    `enable:enable,started:function(category){return started[category]===true}}})();`
  )
}

function vendorScript(provider: Provider, id: string): string {
  return (
    `window.${ANALYTICS_RUNTIME_GLOBAL}.register(${JSON.stringify(provider.category)},` +
    `function(){${provider.script(id)}});`
  )
}

function snippet(name: string, body: string): string {
  return `<!-- ${name} --><script>${body}</script><!-- End ${name} -->`
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
      if (enabled.length === 0) return html
      // The runtime goes first in <head> so a vendor injected anywhere after it
      // can register, and so the app can call `enable` even before any vendor
      // registered.
      const withRuntime = insertBefore(
        html,
        "</head>",
        snippet("Analytics consent runtime", runtimeScript()),
      )
      return enabled.reduce((page, { provider, id }) => {
        const closing = provider.injectTo === "head" ? "</head>" : "</body>"
        return insertBefore(
          page,
          closing,
          snippet(provider.name, vendorScript(provider, id)),
        )
      }, withRuntime)
    },
  }
}
