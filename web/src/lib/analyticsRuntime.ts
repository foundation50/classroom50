import { clearAnalyticsCookies } from "@/lib/analyticsCookies"
import type { ConsentChoices, OptionalConsentCategory } from "@/types/consent"

// Bridge to the consent runtime that web/vite/analytics.ts injects into the
// built page. Absent in dev and test builds without vendor variables, so every
// call is optional-chained.
declare global {
  interface Window {
    __classroom50Analytics?: {
      enable: (categories: OptionalConsentCategory[]) => void
      started: (category: OptionalConsentCategory) => boolean
    }
    dataLayer?: unknown[]
  }
}

// Starts vendors for newly granted categories without a page load. Withdrawn
// consent can't unload a script that already ran, so it tells Google Analytics
// to stop storing and removes its cookies; the next page load honors the
// record fully.
export function applyConsent(choices: ConsentChoices): void {
  const runtime = window.__classroom50Analytics
  const granted = (Object.keys(choices) as OptionalConsentCategory[]).filter(
    (category) => choices[category],
  )
  if (granted.length > 0) runtime?.enable(granted)

  if (!choices.google) {
    if (runtime?.started("google")) {
      // Google Tag Manager only recognizes consent commands pushed as a real
      // `arguments` object (what gtag does), never a plain array.
      const gtag = function () {
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer?.push(arguments)
      } as (...args: unknown[]) => void
      gtag("consent", "update", { analytics_storage: "denied" })
    }
    clearAnalyticsCookies()
  }
}
