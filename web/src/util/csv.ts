// Neutralize spreadsheet formula injection (OWASP CSV injection) in a free-text
// cell that an untrusted party can influence. A value leading with = + - @ (or a
// tab/CR a spreadsheet treats as a formula lead) is prefixed with a single quote
// so Excel/Sheets render it as text, not an executed formula. Idempotent: an
// already-guarded value is returned unchanged. Never apply to values that must
// round-trip byte-exact (ids, tokens, hashes, timestamps).
const FORMULA_LEAD = /^[=+\-@\t\r]/

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
