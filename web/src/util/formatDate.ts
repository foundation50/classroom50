import type { DueMeta } from "@/types/classroom"

import i18n from "@/i18n"
import { BASE_LANG } from "@/i18n/customLocale"

// Drive Intl formatting off the active language. Bare "en" maps to "en-US" to
// preserve US-style output. A sideloaded pack can carry a code Intl rejects with
// a RangeError, so validate and fall back to "en-US" rather than throw on every
// date render.
const resolveLocale = (): string => {
  const lang = i18n.language || "en-US"
  const candidate = lang === BASE_LANG ? "en-US" : lang
  try {
    Intl.getCanonicalLocales(candidate)
    return candidate
  } catch {
    return "en-US"
  }
}

// Intl.DateTimeFormat's locale is fixed at construction, so build formatters
// lazily off the current language rather than once at module load.
const dueDateFormatter = () =>
  new Intl.DateTimeFormat(resolveLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

// `undefined` locale uses the viewer's locale, so the timezone abbreviation is
// region-correct ("BST", not "GMT+1" as a fixed `en-US` would render).
const dueDateTimeFormatter = () =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })

// Legacy bare calendar date (YYYY-MM-DD), vs a full RFC 3339 timestamp.
const isBareDate = (dateString: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(dateString)

// Pin bare dates to local midnight so they don't shift a day in negative offsets.
const parseDueDate = (dateString: string): Date => {
  const normalized = isBareDate(dateString)
    ? `${dateString}T00:00:00`
    : dateString
  return new Date(normalized)
}

export const formatDueDate = (dateString: string): string => {
  const date = parseDueDate(dateString)
  if (Number.isNaN(date.getTime())) {
    return i18n.t("formatDate.invalidDate")
  }

  return dueDateFormatter().format(date)
}

// Bare dates have no time, so fall back to date-only instead of a misleading
// midnight deadline.
export const formatDueDateTime = (dateString: string): string => {
  if (isBareDate(dateString)) {
    return formatDueDate(dateString)
  }

  const date = parseDueDate(dateString)
  if (Number.isNaN(date.getTime())) {
    return i18n.t("formatDate.invalidDate")
  }

  return dueDateTimeFormatter().format(date)
}

// Unlike DateTimeFormat above, an unsupported-but-well-formed tag must fall back
// to English, not the browser default — hence the supportedLocalesOf check.
const relativeTimeFormatter = () => {
  const supported = Intl.RelativeTimeFormat.supportedLocalesOf([
    resolveLocale(),
  ])
  return new Intl.RelativeTimeFormat(supported[0] ?? "en-US", {
    numeric: "always",
  })
}

// Largest whole unit wins. No weeks — day counts up to a month read more
// naturally on a dashboard; month/year lengths are approximations.
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
]

// Relative "x ago" / "in x" in the active UI language via the platform's Intl
// locale data — sideloaded languages need no per-language bundles.
export const formatRelativeToNow = (date: Date | number): string => {
  const diffSeconds = Math.round((new Date(date).getTime() - Date.now()) / 1000)
  const abs = Math.abs(diffSeconds)
  const found = RELATIVE_UNITS.find(([, size]) => abs >= size)
  const [unit, size] = found ?? ["second", 1]
  const value = Math.trunc(diffSeconds / size)
  // -0 keeps a zero diff on the past side ("0 seconds ago", not "in 0 seconds").
  return relativeTimeFormatter().format(value === 0 ? -0 : value, unit)
}

// Relative "x ago" for an invitation timestamp. Returns null on missing/invalid.
export const formatInvitedAt = (dateString?: string | null): string | null => {
  if (!dateString) return null
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return null
  return formatRelativeToNow(date)
}

// The instant a deadline actually falls due, matching isPastDue's parsing: a
// bare YYYY-MM-DD is the *end* of that local day (23:59:59.999), a full
// timestamp is itself. Returns null for an unparseable value. Use this for any
// deadline math (relative countdown, overdue) so the countdown text and the
// past-due flag can't disagree by a day on bare dates.
export const dueDeadlineInstant = (dateString: string): Date | null => {
  const date = isBareDate(dateString)
    ? new Date(`${dateString}T23:59:59.999`)
    : parseDueDate(dateString)
  return Number.isNaN(date.getTime()) ? null : date
}

export const isPastDue = (dateString: string): boolean => {
  const date = dueDeadlineInstant(dateString)
  if (!date) return false
  return date.getTime() < Date.now()
}

const pad = (n: number) => String(n).padStart(2, "0")

const formatOffset = (date: Date): string => {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export type DueFields = { due: string; due_meta?: DueMeta }

// Builds the `due`/`due_meta` pair from the form's due input, mirroring
// gh-teacher's --due: local wall time becomes a UTC instant, with the
// pre-normalization local value/offset/zone in due_meta. Accepts
// `YYYY-MM-DDTHH:MM` and bare `YYYY-MM-DD` (pinned to 23:59 local); anything
// else stored verbatim.
export const buildDueFields = (dueInput: string): DueFields => {
  const dateOnly = isBareDate(dueInput)
  const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(
    dueInput,
  )

  if (!dateOnly && !localDateTime) {
    // Already carries a zone/offset, or isn't a shape we normalize.
    return { due: dueInput }
  }

  let year: number,
    month: number,
    day: number,
    hour = 23,
    minute = 59
  if (dateOnly) {
    ;[year, month, day] = dueInput.split("-").map(Number)
  } else {
    const [datePart, timePart] = dueInput.split("T")
    ;[year, month, day] = datePart.split("-").map(Number)
    ;[hour, minute] = timePart.split(":").map(Number)
  }

  const local = new Date(year, month - 1, day, hour, minute, 0)
  // `new Date` rolls over out-of-range components (Feb 30 -> Mar 2) instead of
  // NaN; reject anything that didn't round-trip so `due` can't disagree with
  // due_meta.input.
  const rolledOver =
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute
  if (Number.isNaN(local.getTime()) || rolledOver) {
    return { due: dueInput }
  }

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const due_meta: DueMeta = {
    input: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`,
    ...(zone ? { zone } : {}),
    offset: formatOffset(local),
    source: "auto-detected",
  }

  return {
    due: local.toISOString().replace(/\.\d{3}Z$/, "Z"),
    due_meta,
  }
}
