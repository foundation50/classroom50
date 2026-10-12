import Papa from "papaparse"

// Neutralize spreadsheet formula injection (OWASP CSV injection) in a free-text
// cell that an untrusted party can influence. A value leading with = + - @ (or a
// tab/CR a spreadsheet treats as a formula lead) is prefixed with a single quote
// so Excel/Sheets render it as text, not an executed formula. Idempotent: an
// already-guarded value is returned unchanged. Never apply to values that must
// round-trip byte-exact (ids, tokens, hashes, timestamps).
const FORMULA_LEAD = /^[=+\-@\t\r]/

// Hand-mirrors the CLI's isFormulaTrigger; a drift test pins the two together.
export const FORMULA_LEAD_SOURCE = FORMULA_LEAD.source

export function hasCsvFormulaLead(value: string): boolean {
  return FORMULA_LEAD.test(value)
}

export function escapeCsvFormulaInjection(value: string): string {
  if (!value) return value
  if (value.startsWith("'") && FORMULA_LEAD.test(value.slice(1))) return value
  return FORMULA_LEAD.test(value) ? `'${value}` : value
}

// Inverse of escapeCsvFormulaInjection, mirroring the gh-teacher CLI's
// undefangCSVCell: strip the guard quote so the in-memory value is the real one
// rather than the on-disk representation. Only the exact `'<trigger>` shape is
// stripped, so a user-typed apostrophe ("'tis") survives.
export function unescapeCsvFormulaInjection(value: string): string {
  return value.startsWith("'") && FORMULA_LEAD.test(value.slice(1))
    ? value.slice(1)
    : value
}

// Trim a CSV header name the same way the CLI does. JS `\s` and Go's
// unicode.IsSpace differ by exactly two code points (U+FEFF is only in JS's set,
// U+0085 only in Go's), so each side adds the other's: without that, a stray
// BOM inside a header cell made `email` an identity column for one tool and an
// extra column for the other, and a rewrite by one produced a file the other
// refused. Mirrors the CLI's trimHeaderName; the shared header fixture pins it.
const HEADER_EDGE = /^[\s\u0085]+|[\s\u0085]+$/g

export function trimCsvHeader(header: string): string {
  return header.replace(HEADER_EDGE, "")
}

// The tolerant read behind every CSV file query (roster.csv included): header
// mode, trimmed header names and cells, empty lines dropped. Papa maps a short
// row positionally and leaves its missing trailing cells undefined for the
// caller's normalizer, so a roster row missing its last cell still reads as a
// student.
export function parseCsvRows<T>(raw: string): T[] {
  return parseCsv<T>(raw).data
}

// The width-strict read behind the group export, the one place the web and the
// CLI must answer in_roster identically. A row short by exactly one trailing
// cell still reads (both tools pad it); a row short by two or more cells, or
// one with surplus cells, is dropped, the shapes the CLI's ParseRosterLenient
// keeps raw. Papa only assigns the keys a row actually had and parks surplus
// cells under __parsed_extra, so width is read off the row, not off error
// indices, which skipEmptyLines can shift. The shared fixture
// (cli/shared/testdata/group_membership_cases.json) feeds its rosters through
// this exact function.
export function parseCsvRowsStrictWidth<T>(raw: string): T[] {
  const parsed = parseCsv<T>(raw)
  const width = parsed.meta.fields?.length ?? 0
  return parsed.data.filter((row) => {
    const cells = row as Record<string, unknown>
    if (PAPA_EXTRA_KEY in cells) return false
    return Object.keys(cells).length >= width - 1
  })
}

const PAPA_EXTRA_KEY = "__parsed_extra"

function parseCsv<T>(raw: string) {
  return Papa.parse<T>(raw, {
    header: true,
    skipEmptyLines: true,
    transformHeader: trimCsvHeader,
    transform: (value: string) => value.trim(),
  })
}
