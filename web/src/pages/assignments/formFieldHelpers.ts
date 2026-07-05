import { useEffect, useState } from "react"

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}

// Minimal subset of a TanStack form field for a string-valued input.
export type StringField = {
  name: string
  state: { value: string }
  handleBlur: () => void
  handleChange: (value: string) => void
}

// onBlur handler that normalizes (default: trim), writing back only on change.
export const normalizeOnBlur = (
  field: StringField,
  normalize: (value: string) => string = (value) => value.trim(),
) => {
  return () => {
    const normalized = normalize(field.state.value)
    if (normalized !== field.state.value) field.handleChange(normalized)
    field.handleBlur()
  }
}

// Format a Date as a `datetime-local` input value (local wall-clock, no zone).
export const toDatetimeLocalValue = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0")

  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())

  return `${year}-${month}-${day}T${hours}:${minutes}`
}

// Create-mode default: a week out gives students a sensible runway and avoids
// the form defaulting to an already-overdue "now".
export const sevenDaysFromNow = () => {
  const date = new Date()
  date.setDate(date.getDate() + 7)
  return date
}

// Parse a stored UTC ISO instant into a `datetime-local` value; "" when absent
// or unparseable.
export const utcIsoToDatetimeLocalValue = (value?: string) => {
  if (!value) return ""

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ""
  }

  return toDatetimeLocalValue(date)
}
