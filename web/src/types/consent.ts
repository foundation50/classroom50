// Cookie and tracking consent. Shared by the app (lib/consent.ts) and the
// build-time analytics loader (web/vite/analytics.ts), which reads the stored
// record before React boots, so the storage shape lives in this leaf module.

// Bump when a category is added or what a category covers changes materially:
// a record from an older version no longer counts as a decision.
export const CONSENT_VERSION = 1
export const CONSENT_STORAGE_KEY = "classroom50:consent"

// The pre-consent opt-out key from the first analytics release. A stored "off"
// is honored as a denial so those visitors are never asked to decide again.
export const LEGACY_ANALYTICS_STORAGE_KEY = "classroom50:analytics"

// Categories a visitor decides on. "necessary" is always granted and has no
// toggle; it exists so the UI can explain what the app stores regardless.
export const OPTIONAL_CONSENT_CATEGORIES = ["analytics"] as const
export type OptionalConsentCategory =
  (typeof OPTIONAL_CONSENT_CATEGORIES)[number]
export type ConsentCategory = "necessary" | OptionalConsentCategory

export type ConsentChoices = Record<OptionalConsentCategory, boolean>

export type ConsentRecord = {
  v: typeof CONSENT_VERSION
  // ISO timestamp of the decision, kept so a future policy change can tell
  // how old a consent is.
  at: string
} & ConsentChoices

export const ALL_DENIED: ConsentChoices = { analytics: false }
export const ALL_GRANTED: ConsentChoices = { analytics: true }
