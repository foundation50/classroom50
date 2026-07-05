import { useCallback, useEffect, useState } from "react"

// Client-side theme preference. Mirrors the `classroom50:sidebar-collapsed`
// pattern: one localStorage key, applied by toggling `data-theme` on <html>.
// The two theme names are the ones registered in index.css.
export const THEME_STORAGE_KEY = "classroom50:theme"

export type Theme = "corporate" | "corporate-dark"

const LIGHT: Theme = "corporate"
const DARK: Theme = "corporate-dark"

// Resolve the initial theme: an explicit stored choice wins; else fall back to
// the OS `prefers-color-scheme`. Kept in sync with the anti-flash inline script
// in index.html, which applies the same logic before React mounts.
export function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return LIGHT
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === LIGHT || stored === DARK) return stored
  const prefersDark = window.matchMedia?.(
    "(prefers-color-scheme: dark)",
  )?.matches
  return prefersDark ? DARK : LIGHT
}

function storedTheme(): Theme | null {
  if (typeof window === "undefined") return null
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored === LIGHT || stored === DARK ? stored : null
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return
  document.documentElement.setAttribute("data-theme", theme)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme)

  // Apply the active theme to <html>. Persistence is deliberately NOT done here:
  // writing on mount would freeze a first-visit OS default into a locked explicit
  // choice, so "follow the OS" could never recover. We persist only on an
  // explicit user action (setTheme/toggleTheme) below.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // While the user has made no explicit choice, follow the OS and any choice
  // made in another tab. Both listeners are no-ops once a value is stored.
  useEffect(() => {
    if (typeof window === "undefined") return

    const mql = window.matchMedia?.("(prefers-color-scheme: dark)")
    const onOsChange = (event: MediaQueryListEvent) => {
      if (storedTheme() === null) setThemeState(event.matches ? DARK : LIGHT)
    }
    mql?.addEventListener("change", onOsChange)

    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return
      if (event.newValue === LIGHT || event.newValue === DARK) {
        setThemeState(event.newValue)
      }
    }
    window.addEventListener("storage", onStorage)

    return () => {
      mql?.removeEventListener("change", onOsChange)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  const persist = useCallback((next: Theme) => {
    setThemeState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    }
  }, [])

  const setTheme = persist
  const toggleTheme = useCallback(
    () => persist(theme === DARK ? LIGHT : DARK),
    [persist, theme],
  )

  return { theme, isDark: theme === DARK, setTheme, toggleTheme }
}
