import { clearAnalyticsCookies } from "@/lib/analyticsCookies"
import {
  ANALYTICS_RUNTIME_GLOBAL,
  OPTIONAL_CONSENT_CATEGORIES,
  type ConsentChoices,
  type OptionalConsentCategory,
} from "@/types/consent"

// Bridge to the consent runtime that web/vite/analytics.ts injects into the
// built page. Absent in dev and test builds without vendor variables, so every
// call is optional-chained.
declare global {
  interface Window {
    [ANALYTICS_RUNTIME_GLOBAL]?: {
      enable: (categories: OptionalConsentCategory[]) => void
      started: (category: OptionalConsentCategory) => boolean
    }
    dataLayer?: unknown[]
  }
}

// Google Tag Manager only recognizes consent commands pushed as a real
// `arguments` object (what gtag does), never a plain array.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function gtag(..._args: unknown[]): void {
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer?.push(arguments)
}

// Starts vendors for newly granted categories without a page load. Withdrawn
// consent can't unload a script that already ran, so it tells Google Analytics
// to stop storing and removes its cookies; the next page load honors the
// record fully. A script that already ran is also why a re-grant must push
// `granted` itself: the runtime starts each vendor once and won't run it again.
export function applyConsent(choices: ConsentChoices): void {
  const runtime = window[ANALYTICS_RUNTIME_GLOBAL]
  const granted = OPTIONAL_CONSENT_CATEGORIES.filter(
    (category) => choices[category],
  )
  const googleWasRunning = runtime?.started("google") === true
  if (granted.length > 0) runtime?.enable(granted)

  if (choices.google) {
    if (googleWasRunning) {
      gtag("consent", "update", { analytics_storage: "granted" })
    }
  } else {
    if (googleWasRunning) {
      gtag("consent", "update", { analytics_storage: "denied" })
    }
    clearAnalyticsCookies()
  }
}
