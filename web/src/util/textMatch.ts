// The list filters' one search rule: trimmed, case-insensitive substring over
// a row's searchable fields. An empty query matches every row.
export const normalizeQuery = (query: string): string =>
  query.trim().toLowerCase()

export function matchesQuery(
  query: string,
  ...fields: Array<string | null | undefined>
): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  return fields.some(
    (field) => Boolean(field) && field!.toLowerCase().includes(q),
  )
}
