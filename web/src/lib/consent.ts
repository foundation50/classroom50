import { localStorageOrNull, setItemOrIgnore } from "@/lib/webStorage"
import {
  ALL_DENIED,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
  OPTIONAL_CONSENT_CATEGORIES,
  type ConsentChoices,
  type ConsentRecord,
} from "@/types/consent"

// Reads the stored decision, or null when the visitor has not decided (nothing
// stored, an older policy version, or an unreadable value). Mirrors the parse
// in web/vite/analytics.ts; keep the two in step.
export function readConsent(): ConsentRecord | null {
  const store = localStorageOrNull()
  const raw = store?.getItem(CONSENT_STORAGE_KEY)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isCurrentRecord(parsed)) return parsed
    } catch {
      // Treated as undecided below.
    }
  }
  // A pre-consent opt-out is a denial the visitor already expressed.
  if (store?.getItem(LEGACY_ANALYTICS_STORAGE_KEY) === "off") {
    return { v: CONSENT_VERSION, at: new Date(0).toISOString(), ...ALL_DENIED }
  }
  return null
}

function isCurrentRecord(value: unknown): value is ConsentRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.v === CONSENT_VERSION &&
    typeof record.at === "string" &&
    OPTIONAL_CONSENT_CATEGORIES.every(
      (category) => typeof record[category] === "boolean",
    )
  )
}

export function writeConsent(choices: ConsentChoices): ConsentRecord {
  const record: ConsentRecord = {
    v: CONSENT_VERSION,
    at: new Date().toISOString(),
    ...choices,
  }
  const store = localStorageOrNull()
  setItemOrIgnore(store, CONSENT_STORAGE_KEY, JSON.stringify(record))
  // The legacy key has served its purpose once a real record exists.
  store?.removeItem(LEGACY_ANALYTICS_STORAGE_KEY)
  return record
}

// Global Privacy Control (and the older Do Not Track) is a standing objection
// the app honors without asking: optional categories stay off and the consent
// prompt is not shown.
export function browserDeclinesTracking(
  nav: { globalPrivacyControl?: unknown; doNotTrack?: unknown } = navigator,
): boolean {
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1"
}
