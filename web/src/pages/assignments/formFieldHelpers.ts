// Re-exported from the shared hooks location so existing imports here keep
// working; the canonical definition lives in hooks/useDebouncedValue.
export { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { dueDeadlineInstant } from "@/util/formatDate"

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
export const toDatetimeLocalValue = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0")

  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())

  return `${year}-${month}-${day}T${hours}:${minutes}`
}

// Parse a stored UTC ISO instant into a `datetime-local` value; "" when absent
// or unparseable. A legacy bare YYYY-MM-DD is that day's end (23:59 local), as
// every reader treats it; `new Date` alone would read it as UTC midnight.
export const utcIsoToDatetimeLocalValue = (value?: string) => {
  if (!value) return ""

  const date = dueDeadlineInstant(value)

  if (!date) {
    return ""
  }

  return toDatetimeLocalValue(date)
}

// Seed for a picker just switched on. An empty `datetime-local` reads "" until
// every segment is filled, and Safari paints a placeholder date into the empty
// segments, so editing only the time never produced a value (#999).
export const dueDateSeed = (now = new Date()) => {
  const d = new Date(now)
  d.setDate(d.getDate() + 7)
  d.setHours(23, 59, 0, 0)
  return toDatetimeLocalValue(d)
}

// Top of the next hour: near future, so the release-date notice is truthful.
export const releaseDateSeed = (now = new Date()) => {
  const d = new Date(now)
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return toDatetimeLocalValue(d)
}

// Deliberately emptied, as opposed to half-edited: a partial entry also reads
// "" but sets `validity.badInput`, and collapsing on it threw away the edit
// (#999). Older Safari reports partial input as valid; the seed avoids that.
export const isDeliberatelyCleared = (input: HTMLInputElement) =>
  input.value === "" && !input.validity?.badInput

// Props for a controlled `type="number"` input whose model is read with
// `valueAsNumber` (#1002). An emptied or half-typed field ("1e" in Chrome,
// "12a" in Firefox) reads NaN; rendering that as "" leaves the DOM alone, where
// a coerced 0 made React write "0" back (select-all+Backspace showed 0, typing
// 5 showed 05). The wheel guard lives in the `Input` primitive.
export const numberInputProps = (value: number | "") => ({
  value: typeof value === "number" && !Number.isFinite(value) ? "" : value,
})
