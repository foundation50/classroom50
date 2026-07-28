// Guarded access to the Web Storage APIs. The property access itself can throw —
// a sandboxed iframe or blocked cookies raises SecurityError on the getter,
// before any read — so persisted-preference modules degrade instead of failing.

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
