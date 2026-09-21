import type { Student } from "@/types/classroom"
import type { NameOrder } from "@/types/preferences"
import {
  isMalformedGitHubId,
  isSameGitHubUser,
  parseGitHubId,
  resolveGitHubId,
} from "@/util/identity"

export { isMalformedGitHubId, isSameGitHubUser, parseGitHubId, resolveGitHubId }
export type { NameOrder }

// The order names read in when a caller has no user preference to hand (pure
// domain code, tests). Views read the real preference via
// useUserPreference("nameOrder") and pass it down.
export const DEFAULT_NAME_ORDER: NameOrder = "first-last"

export const capitalize = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : ""

// First user-perceived character, or "" when empty. `s[0]` and `slice(0, 1)`
// yield a UTF-16 code *unit*, so a roster name starting with an emoji would
// render as a lone surrogate. Lazy + feature-tested: this module is imported
// app-wide, so a runtime without Intl.Segmenter must degrade, not blank the page.
let segmenter: Intl.Segmenter | null | undefined

export const firstGrapheme = (s: string): string => {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null
  }
  if (!segmenter) return s.slice(0, 1)
  const [first] = segmenter.segment(s)
  return first?.segment ?? ""
}

// Find a roster student by username, case-insensitively: GitHub logins and
// scores.json logins can differ in case from the CSV, so `===` would miss.
const findByUsername = (key: string, students: Student[]) => {
  const k = key.trim().toLowerCase()
  return students.find((s) => s.username.trim().toLowerCase() === k)
}

// Minimal Student carrying only the username; fallback when off-roster.
export const placeholderStudent = (username: string): Student => ({
  username,
  first_name: "",
  last_name: "",
  email: "",
  section: "",
  github_id: "",
  role: "",
})

// The roster Student for a username, or a placeholder so callers always get one.
export const resolveStudent = (key: string, students: Student[]): Student =>
  findByUsername(key, students) ?? placeholderStudent(key)

// A student's display name by username in the user's name order, or "" when
// the login isn't on the roster or has no name (callers fall back to the login).
export const getName = (
  key: string,
  students: Student[],
  order: NameOrder,
): string => {
  const student = findByUsername(key, students)
  if (!student) return ""
  return formatName(student.first_name, student.last_name, order)
}

// Display name for a username in a sorted view. Follows the user's name order,
// except that a first-last user sorting by last name sees "Last, First" so the
// label reads in the order it sorts (the comma marks the inversion). A
// last-first user already reads surname-first, so their labels never flip.
// "" when the login isn't on the roster or has no name.
export const getDisplayName = (
  key: string,
  students: Student[],
  order: NameOrder,
  sortMode: StudentSortMode = DEFAULT_STUDENT_SORT,
): string => {
  const student = findByUsername(key, students)
  if (!student) return ""
  if (order === "first-last" && sortMode === "last") {
    return nameLastFirst(student.first_name, student.last_name)
  }
  return formatName(student.first_name, student.last_name, order)
}

// Display name from a roster row's first/last parts in the given order; ""
// when neither present. The single formatter every name-showing surface
// routes through, so the Settings preference applies everywhere at once.
export const formatName = (
  firstName: string | undefined,
  lastName: string | undefined,
  order: NameOrder,
): string =>
  order === "last-first"
    ? nameFromParts(lastName, firstName)
    : nameFromParts(firstName, lastName)

// "First Last" from a roster row's parts; "" when neither present. Order-fixed
// on purpose: sort keys and the roster's own column order use it. Display
// surfaces call formatName instead.
export const nameFromParts = (
  firstName?: string,
  lastName?: string,
): string => {
  const first = firstName?.trim() ?? ""
  const last = lastName?.trim() ?? ""
  if (!first && !last) return ""
  if (!first) return capitalize(last)
  if (!last) return capitalize(first)
  return `${capitalize(first)} ${capitalize(last)}`
}

// "Lastname, Firstname" display form, used when a view is ordered by last name
// so the on-screen name reads in the same order it sorts. Falls back to a single
// present part (no stray comma), and "" when neither is set — mirroring
// nameFromParts so callers can swap between the two by mode alone.
export const nameLastFirst = (
  firstName?: string,
  lastName?: string,
): string => {
  const first = firstName?.trim() ?? ""
  const last = lastName?.trim() ?? ""
  if (!first && !last) return ""
  if (!last) return capitalize(first)
  if (!first) return capitalize(last)
  return `${capitalize(last)}, ${capitalize(first)}`
}

// A name in both orders, for search fields: a query typed the way names show
// on screen matches whichever order the user prefers, and "Ada Lovelace" still
// finds a "Lovelace Ada" roster. Empty when the row has no name.
export const nameSearchFields = (
  firstName?: string,
  lastName?: string,
): string[] => {
  const forward = nameFromParts(firstName, lastName)
  if (!forward) return []
  const reverse = nameFromParts(lastName, firstName)
  return reverse === forward ? [forward] : [forward, reverse]
}

export const getInitials = (key: string, students: Student[]) => {
  const student = findByUsername(key, students)
  if (!student) return ""
  return initialsFromParts(student.first_name, student.last_name)
}

// Avatar initials from first/last parts; "" when neither present.
export const initialsFromParts = (
  firstName?: string,
  lastName?: string,
): string => {
  const first = firstGrapheme((firstName ?? "").trim()).toUpperCase()
  const last = firstGrapheme((lastName ?? "").trim()).toUpperCase()
  return `${first}${last}`
}

// A student's section by username, or "" if unknown/unset.
export const getSection = (key: string, students: Student[]): string =>
  findByUsername(key, students)?.section?.trim() ?? ""

// Whether a roster is ordered by first name ("First Last") or by last name
// ("Last First"). Gradebooks are usually last-name first, so a teacher can pick
// that order to transcribe grades without re-reading each row.
export type StudentSortMode = "first" | "last"

export const DEFAULT_STUDENT_SORT: StudentSortMode = "first"

// The name sort a view should open in: by whichever part the user's name order
// puts first, so a "Last First" roster doesn't look shuffled on arrival.
export const defaultStudentSortMode = (order: NameOrder): StudentSortMode =>
  order === "last-first" ? "last" : "first"

// One collation regime for every "by name" ordering in the app (roster views,
// team roster, and the exported gradebook CSV), so the same students never sort
// differently across surfaces. `numeric: true` keeps digit-bearing names in
// natural order (student2 before student10).
export const NAME_COLLATION: Intl.CollatorOptions = { numeric: true }

// Case-insensitive sort key for ordering a roster by display name: full name
// when known, else username, else email. Mirrors the team-roster sortKey so the
// dashboard's deterministic order matches other roster views.
export const studentSortKey = (student: Student): string => {
  const name = nameFromParts(student.first_name, student.last_name)
  return (name || student.username || student.email || "").toLowerCase()
}

// Last-name-first sort key ("Last First"), same fallback chain as
// studentSortKey (username, then email) when no name is recorded, so a
// nameless row still sorts deterministically in either mode.
export const studentSortKeyByLastName = (student: Student): string => {
  const name = nameFromParts(student.last_name, student.first_name)
  return (name || student.username || student.email || "").toLowerCase()
}

// Name sort key for a student in the given mode — first-name ("First Last") or
// last-name ("Last First") order. Single dispatch so callers that sort loose
// rows (not full Student arrays) use the same keys as compareStudentsByName.
export const studentSortKeyFor = (
  student: Student,
  mode: StudentSortMode,
): string =>
  mode === "last" ? studentSortKeyByLastName(student) : studentSortKey(student)

// Shared comparator for a roster ordered by name in the given mode, with the
// lowercased username as a deterministic tie-break so two students who share a
// name (or resolve to the same key) always keep a stable, identity-based order
// — not one that depends on input/collection order. Every by-name sort routes
// through this so collation and tie-break can't drift between surfaces.
export const compareStudentsByName =
  (mode: StudentSortMode = DEFAULT_STUDENT_SORT) =>
  (a: Student, b: Student): number => {
    const byName = studentSortKeyFor(a, mode).localeCompare(
      studentSortKeyFor(b, mode),
      undefined,
      NAME_COLLATION,
    )
    if (byName !== 0) return byName
    return a.username
      .trim()
      .toLowerCase()
      .localeCompare(b.username.trim().toLowerCase(), undefined, NAME_COLLATION)
  }

// Roster sorted by display name, stable and case-insensitive (see
// compareStudentsByName). `mode` defaults to first-name so existing call sites
// keep their order.
export const sortStudentsByName = (
  students: Student[],
  mode: StudentSortMode = DEFAULT_STUDENT_SORT,
): Student[] => students.toSorted(compareStudentsByName(mode))
