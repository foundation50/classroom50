// Per-browser user preferences (Settings page). Values are plain string enums so
// each one round-trips through localStorage without serialization. Register a
// new preference's storage key and default in lib/userPreferences.ts.

// The order student names read in: "First Last" (the roster's own column order)
// or "Last First", the natural order in many East Asian and Central European
// naming conventions, and the gradebook order some teachers transcribe from.
export const NAME_ORDERS = ["first-last", "last-first"] as const
export type NameOrder = (typeof NAME_ORDERS)[number]
export const DEFAULT_NAME_ORDER: NameOrder = "first-last"

// Anonymous usage analytics (Cloudflare Web Analytics). "off" is the only value
// ever stored. The storage key lives here, not in the registry, because the
// analytics loader that vite.config.ts injects into index.html reads it before
// React boots, the same way the anti-flash scripts read theme/motion.
export const ANALYTICS_PREFS = ["on", "off"] as const
export type AnalyticsPref = (typeof ANALYTICS_PREFS)[number]
export const DEFAULT_ANALYTICS_PREF: AnalyticsPref = "on"
export const ANALYTICS_STORAGE_KEY = "classroom50:analytics"

export type UserPreferences = {
  nameOrder: NameOrder
  analytics: AnalyticsPref
}

export type UserPreferenceKey = keyof UserPreferences
