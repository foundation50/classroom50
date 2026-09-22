import { localStorageOrNull, setItemOrIgnore } from "@/lib/webStorage"
import {
  DEFAULT_NAME_ORDER,
  NAME_ORDERS,
  type UserPreferenceKey,
  type UserPreferences,
} from "@/types/preferences"

// Registry of the Settings-page preferences that live in localStorage, one
// `classroom50:<name>` key each (the house convention, so a key is greppable
// and clearable on its own). Theme, motion, and language stay in their own
// modules: they also drive an anti-flash script or an OS media query, which
// this plain enum store deliberately doesn't model.
type PreferenceSpec<T extends string> = {
  storageKey: string
  values: readonly T[]
  default: T
}

export const USER_PREFERENCE_SPECS: {
  readonly [K in UserPreferenceKey]: PreferenceSpec<UserPreferences[K]>
} = {
  nameOrder: {
    storageKey: "classroom50:name-order",
    values: NAME_ORDERS,
    default: DEFAULT_NAME_ORDER,
  },
}

export const USER_PREFERENCE_KEYS = Object.keys(
  USER_PREFERENCE_SPECS,
) as UserPreferenceKey[]

export const DEFAULT_USER_PREFERENCES: UserPreferences = Object.fromEntries(
  USER_PREFERENCE_KEYS.map((key) => [key, USER_PREFERENCE_SPECS[key].default]),
) as UserPreferences

function isAllowed<K extends UserPreferenceKey>(
  key: K,
  value: string | null,
): value is UserPreferences[K] {
  return (
    value !== null &&
    (USER_PREFERENCE_SPECS[key].values as readonly string[]).includes(value)
  )
}

// The stored value when it's one this build understands, else the default: an
// unset key, a cleared tab, or a value written by a newer release all resolve
// the same way rather than leaking an unknown string into the UI.
export function readUserPreference<K extends UserPreferenceKey>(
  key: K,
): UserPreferences[K] {
  const stored =
    localStorageOrNull()?.getItem(USER_PREFERENCE_SPECS[key].storageKey) ?? null
  return isAllowed(key, stored) ? stored : USER_PREFERENCE_SPECS[key].default
}

export function readUserPreferences(): UserPreferences {
  return Object.fromEntries(
    USER_PREFERENCE_KEYS.map((key) => [key, readUserPreference(key)]),
  ) as UserPreferences
}

// The default is the absence of a choice, so it clears the key instead of
// storing a sentinel (matches theme/motion), and a future default change
// applies to everyone who never picked.
export function persistUserPreference<K extends UserPreferenceKey>(
  key: K,
  value: UserPreferences[K],
): void {
  const { storageKey, default: fallback } = USER_PREFERENCE_SPECS[key]
  const store = localStorageOrNull()
  if (value === fallback) store?.removeItem(storageKey)
  else setItemOrIgnore(store, storageKey, value)
}

// Which preference a `storage` event is about, or null for an unrelated key.
export function preferenceKeyForStorageKey(
  storageKey: string | null,
): UserPreferenceKey | null {
  if (storageKey === null) return null
  return (
    USER_PREFERENCE_KEYS.find(
      (key) => USER_PREFERENCE_SPECS[key].storageKey === storageKey,
    ) ?? null
  )
}
