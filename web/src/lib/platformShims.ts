// Small platform shims for APIs newer than the build's browser floor (Vite's
// default `baseline-widely-available`, currently Safari 16.4 / Chrome 111 /
// Firefox 114). esbuild transpiles syntax only; it never polyfills.

// AbortSignal.any (Safari 17.4 / Chrome 116 / Firefox 124): abort when any of
// the inputs aborts, forwarding the first reason.
export function anyAbortSignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    })
  }
  return controller.signal
}

// Map.groupBy (Safari 17.4 / Chrome 117 / Firefox 119), preserving first-seen
// key order like the native.
export function groupBy<T, K>(
  items: Iterable<T>,
  keyOf: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}
