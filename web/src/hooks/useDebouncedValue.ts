import { useEffect, useState } from "react"

// Return `value` delayed by `delayMs`, resetting the timer on every change so
// the debounced value only settles once input pauses. Used to throttle
// query-key inputs (e.g. a form field that drives a network request) so a
// request fires per pause, not per keystroke.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
