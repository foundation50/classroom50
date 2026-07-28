// Guarded access to the Web Storage APIs. `window` can exist while
// `localStorage`/`sessionStorage` is absent (some SSR/test DOMs, storage
// disabled), and the property access itself can *throw* — a sandboxed iframe or
// blocked cookies raises a SecurityError on the getter, before any read. The
// persisted-preference modules degrade to their defaults rather than failing, so
// they go through here instead of touching the globals directly.

function probe(key: "localStorage" | "sessionStorage"): Storage | null {
  try {
    if (typeof window === "undefined") return null
    return window[key] ?? null
  } catch {
    return null
  }
}

export function localStorageOrNull(): Storage | null {
  return probe("localStorage")
}

export function sessionStorageOrNull(): Storage | null {
  return probe("sessionStorage")
}
