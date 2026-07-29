// Re-exported from the shared hooks location so existing imports here keep
// working; the canonical definition lives in hooks/useDebouncedValue.
export { useDebouncedValue } from "@/hooks/useDebouncedValue"

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
const toDatetimeLocalValue = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0")

  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())

  return `${year}-${month}-${day}T${hours}:${minutes}`
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
