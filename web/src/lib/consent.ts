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
// stored, an older policy version, or an unreadable value). The injected
// runtime in web/vite/analytics.ts parses the same record before React boots;
// its parity test keeps the two in step.
export function readConsent(): ConsentRecord | null {
  const store = localStorageOrNull()
  // getItem itself throws in some hardened modes; that reads as undecided, the
  // same as the injected runtime.
  try {
    const raw = store?.getItem(CONSENT_STORAGE_KEY)
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isCurrentRecord(parsed)) return parsed
      } catch {
        // Unreadable record: fall through to the legacy key.
      }
    }
    // A pre-consent opt-out is a denial the visitor already expressed.
    if (store?.getItem(LEGACY_ANALYTICS_STORAGE_KEY) === "off") {
      return {
        v: CONSENT_VERSION,
        at: new Date(0).toISOString(),
        ...ALL_DENIED,
      }
    }
  } catch {
    // Storage blocked: undecided.
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

// `choices` may be a whole record (the form seeds its draft from one), so the
// version and timestamp are written last and always describe this decision.
export function writeConsent(choices: ConsentChoices): ConsentRecord {
  const record: ConsentRecord = {
    ...choices,
    v: CONSENT_VERSION,
    at: new Date().toISOString(),
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

// Forgets the decision so the prompt asks again. The legacy key goes too, or
// it would immediately read back as a denial.
export function clearConsent(): void {
  const store = localStorageOrNull()
  store?.removeItem(CONSENT_STORAGE_KEY)
  store?.removeItem(LEGACY_ANALYTICS_STORAGE_KEY)
}
