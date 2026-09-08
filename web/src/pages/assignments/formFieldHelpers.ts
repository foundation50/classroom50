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

// The first validation error, as the string FormField renders. TanStack types
// errors as unknown[] because a validator may return anything; every validator
// in this form returns a translated string.
export const fieldError = (field: {
  state: { meta: { errors: unknown[] } }
}): string | undefined => {
  const [first] = field.state.meta.errors
  return first === undefined ? undefined : String(first)
}

// The props every control inside a FormField repeats: the ids FormField
// minted, the field's name and value, and the blur that marks it touched.
// Spread first so a caller can still override any of them (a normalizing
// onBlur, a different value mapping).
export const fieldControlProps = <V>(
  field: { name: string; state: { value: V }; handleBlur: () => void },
  args: { id: string; describedById: string | undefined; invalid: boolean },
) => ({
  id: args.id,
  name: field.name,
  "aria-describedby": args.describedById,
  invalid: args.invalid,
  value: field.state.value,
  onBlur: field.handleBlur,
})

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
