// Per-browser user preferences (Settings page). Values are plain string enums so
// each one round-trips through localStorage without serialization. Add a
// preference here, then register its storage key and default in
// lib/userPreferences.ts; the type keeps the two in lockstep.

// The order student names read in: "First Last" (the roster's own column order)
// or "Last First", the natural order in many East Asian and Central European
// naming conventions, and the gradebook order some teachers transcribe from.
export const NAME_ORDERS = ["first-last", "last-first"] as const
export type NameOrder = (typeof NAME_ORDERS)[number]

export type UserPreferences = {
  nameOrder: NameOrder
}

export type UserPreferenceKey = keyof UserPreferences
