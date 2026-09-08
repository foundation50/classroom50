export type SortDirection = "asc" | "desc"

// Header-driven column sort shared by the roster and members tables. `desc`
// flips only the column comparison; ties always fall back to the ascending
// tie-break (display name) so a reversed column stays internally scannable.
export function sortByColumn<T>(
  rows: readonly T[],
  direction: SortDirection,
  byColumn: (a: T, b: T, blankLast: BlankLastCompare) => number,
  tieBreak: (a: T, b: T) => number,
): T[] {
  const flip = direction === "desc" ? -1 : 1
  const blankLast = compareBlankLast(flip)
  return rows.toSorted(
    (a, b) => flip * byColumn(a, b, blankLast) || tieBreak(a, b),
  )
}

export type BlankLastCompare = (a: string, b: string) => number

// Locale/numeric compare with blank values pinned last in EITHER direction: a
// missing value is "no data", not "smallest". The inner flip cancels the outer
// one the sort applies, so a reversed column never leads with its blanks.
export const compareBlankLast =
  (flip: 1 | -1): BlankLastCompare =>
  (va, vb) => {
    if (!va || !vb) return flip * (va === vb ? 0 : va ? -1 : 1)
    return va.localeCompare(vb, undefined, { numeric: true })
  }
