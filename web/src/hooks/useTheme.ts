import { useCallback, useEffect, useState } from "react"

// Client-side theme preference. Mirrors the `classroom50:sidebar-collapsed`
// pattern: one localStorage key, applied by toggling `data-theme` on <html>.
// The two theme names ("sumi" light / "sumi-dark" dark) are the ones registered
// in index.css.
export const THEME_STORAGE_KEY = "classroom50:theme"

export type Theme = "sumi" | "sumi-dark"

// The user's *preference*, distinct from the resolved `Theme`. "system" means
// no explicit choice (follow the OS `prefers-color-scheme`); the concrete themes
// pin light/dark. Stored as the theme name, or absent for "system".
export type ThemePref = "system" | Theme

const LIGHT: Theme = "sumi"
const DARK: Theme = "sumi-dark"

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

// The preference to show in a settings control: the stored theme, or "system"
// when nothing explicit is stored (the app then tracks the OS).
export function resolveInitialThemePref(): ThemePref {
  return storedTheme() ?? "system"
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

// Cross-fade an explicit light<->dark switch via the View Transitions API: the
// browser snapshots the old page, applies the theme, and GPU-composites a
// single cross-fade between the two snapshots (smooth, unlike transitioning
// every element's colors at once). Falls back to an instant apply where the API
// is unavailable. Duration/easing live in the `::view-transition-*` rules in
// index.css; reduced-motion is handled there too.
function applyThemeAnimated(theme: Theme) {
  if (typeof document === "undefined") return
  const startViewTransition = (
    document as Document & {
      startViewTransition?: (cb: () => void) => unknown
    }
  ).startViewTransition
  if (typeof startViewTransition !== "function") {
    applyTheme(theme)
    return
  }
  startViewTransition.call(document, () => applyTheme(theme))
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme)
  // The preference the UI shows: "system" while no explicit choice is stored
  // (the app then follows the OS), else the stored theme. Tracked alongside the
  // resolved `theme` so a settings control can offer System/Light/Dark while the
  // rest of the app keeps consuming the concrete resolved theme.
  const [pref, setPrefState] = useState<ThemePref>(resolveInitialThemePref)

  // Only an explicit user toggle cross-fades. Apply the active theme to <html>
  // here without animating: the first run re-asserts what the anti-flash script
  // already painted, and OS/cross-tab changes are external — cross-fading either
  // would abort a user's in-flight transition (a non-user event landing inside
  // the ~600ms fade re-snapshots the page) and animate motion the user didn't
  // ask for. Persistence is deliberately NOT done here: writing on mount would
  // freeze a first-visit OS default into a locked explicit choice, so "follow
  // the OS" could never recover. We persist (and animate) only on an explicit
  // user action (setTheme/toggleTheme) below.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Follow external theme changes. The OS listener only applies while no
  // explicit choice is stored (a stored light/dark pins the theme against OS
  // drift); the storage listener always mirrors a cross-tab write, including a
  // clear back to "system".
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
        setPrefState(event.newValue)
      } else if (event.newValue === null) {
        // A cross-tab reset to "system": drop back to following the OS.
        setPrefState("system")
        setThemeState(resolveInitialTheme())
      }
    }
    window.addEventListener("storage", onStorage)

    return () => {
      mql?.removeEventListener("change", onOsChange)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  const persist = useCallback((next: Theme) => {
    // A user toggle is the only path that cross-fades; state still holds the new
    // theme, but painting it through the View Transition here (rather than in the
    // [theme] effect) keeps OS/cross-tab-driven changes instant.
    applyThemeAnimated(next)
    setThemeState(next)
    setPrefState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    }
  }, [])

  const setTheme = persist
  const toggleTheme = useCallback(
    () => persist(theme === DARK ? LIGHT : DARK),
    [persist, theme],
  )

  // Set the tri-state preference. "system" clears the stored choice (rather than
  // storing a sentinel — the resolver treats a missing key as "system") and
  // resolves the concrete theme from the current OS setting; the change still
  // cross-fades since it's an explicit user action.
  const setThemePref = useCallback(
    (next: ThemePref) => {
      if (next !== "system") {
        persist(next)
        return
      }
      setPrefState("system")
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(THEME_STORAGE_KEY)
      }
      const resolved = resolveInitialTheme()
      setThemeState(resolved)
      // Only cross-fade when the resolved theme actually differs — picking
      // "system" while already showing the OS theme shouldn't fire a no-op
      // View Transition.
      if (resolved !== theme) applyThemeAnimated(resolved)
    },
    [persist, theme],
  )

  return {
    theme,
    pref,
    isDark: theme === DARK,
    setTheme,
    setThemePref,
    toggleTheme,
  }
}
