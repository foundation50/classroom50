import type { DroppedRow } from "@/pages/students/rosterImportParse"
import type { UnusableRow } from "@/pages/students/rosterImportResolve"

// A row the import won't act on, from either stage: the parse (a cell we couldn't
// read) or the resolution (a github_id we couldn't trade for a login). One shape
// for both so the preview reports them in one list, ordered by file line, instead
// of two disjoint counts the teacher has to reconcile against the file by hand.
export type ImportProblem = {
  line: number
  // The i18n key for this problem's one-line explanation. Every key interpolates
  // { line }; all but `incomplete` also interpolate { value }.
  key: string
  // The offending cell, verbatim (truncated), so the teacher can find it in the
  // file. Empty for `incomplete`, which has no cell to quote.
  value: string
  // False for a row that's merely INCOMPLETE — no identity cell at all. See
  // classifyImportProblems for why that one case doesn't block.
  blocking: boolean
}

// A pathological cell (a whole pasted paragraph, a mis-quoted CSV field) must not
// blow out the report, and the teacher only needs enough to locate it.
const MAX_VALUE_CHARS = 80

// The report renders each sentence through <Trans>, which parses the interpolated
// string as markup — so an angle bracket in a cell would swallow the rest of the
// value, hiding the very thing the teacher needs to find (`Ada <ada@uni.edu>`
// would display as `Ada`). Strip the brackets rather than escaping them: the value
// is a locator, and no valid handle, address, or id contains one.
const displayValue = (value: string) => {
  const flat = value.replace(/[<>]/g, "")
  return flat.length > MAX_VALUE_CHARS
    ? `${flat.slice(0, MAX_VALUE_CHARS)}…`
    : flat
}

const DROP_KEYS: Record<DroppedRow["reason"], string> = {
  "bad-email": "students.dropBadEmail",
  "bad-username": "students.dropBadUsername",
  "bad-value": "students.dropBadValue",
  incomplete: "students.dropIncomplete",
}

const UNUSABLE_KEYS: Record<UnusableRow["reason"], string> = {
  "unresolved-id": "students.dropUnresolvedId",
  "id-lookup-failed": "students.dropIdLookupFailed",
  "id-lookup-capped": "students.dropIdLookupCapped",
}

// Merge and classify both stages' rejected rows.
//
// The blocking rule is one sentence: content we couldn't use blocks the import;
// absent content doesn't. A cell holding `n/a`, a mangled id, or a shifted column
// means something is wrong with the FILE — importing the remainder would act on a
// file the teacher and the app disagree about, so we report every offending line
// and let them fix it (re-importing is idempotent, so that round-trip is cheap).
// A row with no identity cell at all is different in kind: a student who hasn't
// signed up yet is normal in an SIS export, there is nothing to correct, and
// blocking would strand every addressable classmate.
//
// An id we couldn't LOOK UP blocks too, for the reason the resolution fails
// closed: we don't know whose account that is, so we must not skip past it.
export const classifyImportProblems = (
  dropped: readonly DroppedRow[],
  unusable: readonly UnusableRow[],
): ImportProblem[] => {
  const problems: ImportProblem[] = [
    ...dropped.map((row) => ({
      line: row.line,
      key: DROP_KEYS[row.reason],
      value: row.reason === "incomplete" ? "" : displayValue(row.value),
      blocking: row.reason !== "incomplete",
    })),
    ...unusable.map((row) => ({
      line: row.line,
      key: UNUSABLE_KEYS[row.reason],
      value: displayValue(row.githubId),
      blocking: true,
    })),
  ]
  return problems.sort((a, b) => a.line - b.line)
}
