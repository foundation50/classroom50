import { useCallback, useEffect, useMemo, useState } from "react"

import { localStorageOrNull } from "@/lib/webStorage"

// Client-side motion preference. Mirrors the `useTheme` pattern: one
// localStorage key, resolved on mount, applied by toggling an attribute on
// <html>. Three states, so a user can override the OS in EITHER direction —
// force motion off on a machine that doesn't set `prefers-reduced-motion`, or
// force it on despite an OS-level reduce setting:
//   - "system" (default): follow the OS `prefers-reduced-motion` media query.
//   - "on":  always animate, ignoring the OS.
//   - "off": never animate.
// The RESOLVED verdict (a single boolean) drives both motion layers at once:
//   - CSS: `data-reduce-motion="true"` on <html> feeds the attribute-scoped
//     safety net in index.css (a sibling of the `@media (prefers-reduced-motion)`
//     rule), neutralizing every CSS transition/animation.
//   - Motion JS: the boolean flips <MotionConfig reducedMotion> between "always"
//     and "user" (see main.tsx), so JS variants collapse too.
export const MOTION_STORAGE_KEY = "classroom50:motion"

export type MotionPref = "system" | "on" | "off"

const PREFS: readonly MotionPref[] = ["system", "on", "off"] as const
const DEFAULT_PREF: MotionPref = "system"

const isMotionPref = (v: string | null): v is MotionPref =>
  v !== null && (PREFS as readonly string[]).includes(v)

// The stored explicit choice, or null when unset/corrupt (→ "system"). Kept in
// sync with the anti-flash inline script in index.html, which reads the same key.
export function storedMotionPref(): MotionPref | null {
  const stored = localStorageOrNull()?.getItem(MOTION_STORAGE_KEY) ?? null
  return isMotionPref(stored) ? stored : null
}

export function resolveInitialMotionPref(): MotionPref {
  return storedMotionPref() ?? DEFAULT_PREF
}

function osPrefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  )
}

// Fold the tri-state preference + the OS signal into the single "should we
// suppress motion" verdict that both CSS and Motion consume.
export function motionReduced(pref: MotionPref, osReduced: boolean): boolean {
  if (pref === "off") return true
  if (pref === "on") return false
  return osReduced
}

function applyReducedMotion(reduced: boolean) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (reduced) root.setAttribute("data-reduce-motion", "true")
  else root.removeAttribute("data-reduce-motion")
}

export function useReducedMotion() {
  const [pref, setPrefState] = useState<MotionPref>(resolveInitialMotionPref)
  const [osReduced, setOsReduced] = useState<boolean>(osPrefersReducedMotion)

  const reduced = motionReduced(pref, osReduced)

  // Reflect the resolved verdict onto <html> for the CSS layer. The first run
  // re-asserts what the anti-flash script already applied; subsequent runs
  // track pref/OS changes.
  useEffect(() => {
    applyReducedMotion(reduced)
  }, [reduced])

  // Track the OS preference (matters only while pref === "system", but the
  // boolean is cheap to keep current) and any choice made in another tab.
  useEffect(() => {
    if (typeof window === "undefined") return

    const mql = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    const onOsChange = (event: MediaQueryListEvent) =>
      setOsReduced(event.matches)
    mql?.addEventListener("change", onOsChange)

    const onStorage = (event: StorageEvent) => {
      if (event.key !== MOTION_STORAGE_KEY) return
      // A cross-tab clear (null) or corrupt value resets to the default.
      setPrefState(isMotionPref(event.newValue) ? event.newValue : DEFAULT_PREF)
    }
    window.addEventListener("storage", onStorage)

    return () => {
      mql?.removeEventListener("change", onOsChange)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  const setPref = useCallback((next: MotionPref) => {
    setPrefState(next)
    const store = localStorageOrNull()
    // "system" is the absence of an explicit choice, so clear the key rather
    // than storing a sentinel — matches how the resolver treats a missing key.
    if (next === "system") store?.removeItem(MOTION_STORAGE_KEY)
    else store?.setItem(MOTION_STORAGE_KEY, next)
  }, [])

  return useMemo(() => ({ pref, reduced, setPref }), [pref, reduced, setPref])
}
