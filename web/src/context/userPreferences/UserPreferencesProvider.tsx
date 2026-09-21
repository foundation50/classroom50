import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  DEFAULT_USER_PREFERENCES,
  persistUserPreference,
  preferenceKeyForStorageKey,
  readUserPreference,
  readUserPreferences,
} from "@/lib/userPreferences"
import type { UserPreferenceKey, UserPreferences } from "@/types/preferences"

type UserPreferencesContextValue = {
  preferences: UserPreferences
  setPreference: <K extends UserPreferenceKey>(
    key: K,
    value: UserPreferences[K],
  ) => void
}

// Defaults with a no-op setter, so a subtree rendered without the provider
// (tests, storybook-style fixtures) still reads sensible values.
const UserPreferencesContext = createContext<UserPreferencesContextValue>({
  preferences: DEFAULT_USER_PREFERENCES,
  setPreference: () => {},
})

export const useUserPreferences = () => useContext(UserPreferencesContext)

// The current value of one preference. The usual consumer entry point: a view
// that formats names asks for `useUserPreference("nameOrder")`.
export function useUserPreference<K extends UserPreferenceKey>(
  key: K,
): UserPreferences[K] {
  return useUserPreferences().preferences[key]
}

// Holds every registry preference (lib/userPreferences.ts) reactively, so the
// Settings page and each consuming view re-render together on a change, in
// this tab or another. Mirrors HiddenOrgsProvider's context-over-localStorage
// shape; adding a preference needs no change here.
export const UserPreferencesProvider = ({
  children,
}: {
  children: ReactNode
}) => {
  const [preferences, setPreferences] =
    useState<UserPreferences>(readUserPreferences)

  const setPreference = useCallback(
    <K extends UserPreferenceKey>(key: K, value: UserPreferences[K]) => {
      persistUserPreference(key, value)
      setPreferences((prev) =>
        prev[key] === value ? prev : { ...prev, [key]: value },
      )
    },
    [],
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (event: StorageEvent) => {
      const key = preferenceKeyForStorageKey(event.key)
      if (!key) return
      // Re-read rather than trust newValue: the reader applies the allow-list
      // and default fallback for a cleared or corrupt value.
      const value = readUserPreference(key)
      setPreferences((prev) =>
        prev[key] === value ? prev : { ...prev, [key]: value },
      )
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const value = useMemo<UserPreferencesContextValue>(
    () => ({ preferences, setPreference }),
    [preferences, setPreference],
  )

  return (
    <UserPreferencesContext.Provider value={value}>
      {children}
    </UserPreferencesContext.Provider>
  )
}
