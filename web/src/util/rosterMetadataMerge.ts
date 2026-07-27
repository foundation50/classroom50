import type { StudentCsvRow } from "@/util/rosterCsv"

// The roster.csv metadata fields a CSV upload can update on an existing member.
// A deliberate subset of StudentCsvRow: identity (username/github_id) and role
// are never touched by the metadata merge — role has its own writeback and
// identity is the join key, not a mutable field.
export const METADATA_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "section",
] as const

export type MetadataField = (typeof METADATA_FIELDS)[number]

// The updatable metadata carried by an uploaded row (all optional — a CSV may
// omit any column).
export type StudentMetadata = Partial<Record<MetadataField, string>>

export type MergeStudentMetadataResult = {
  // The four metadata fields after applying the merge rule.
  next: Record<MetadataField, string>
  // The fields whose value actually changed (empty when the merge is a no-op).
  changedFields: MetadataField[]
}

// Non-empty-overwrite merge: for each metadata field the CSV value wins ONLY
// when it is non-empty (after trim) AND differs from the stored value;
// otherwise the stored value is kept. A blank CSV cell never clears stored data
// (the plan's R2/KTD4) — it can fill a gap or correct a value, never erase one.
//
// The single source of truth for "is there a metadata delta" — used by BOTH the
// preflight classifier (to decide metadata_update vs no_action) and the writer
// (to compute the next row), so the two can never disagree. Trims before
// comparing to match normalizeStudentRow's stored-value semantics, so a guarded
// round-trip (escape on write, unescape on read) doesn't register as a change.
export function mergeStudentMetadata(
  stored: StudentMetadata,
  csv: StudentMetadata,
): MergeStudentMetadataResult {
  const next = {} as Record<MetadataField, string>
  const changedFields: MetadataField[] = []
  for (const field of METADATA_FIELDS) {
    const storedValue = (stored[field] ?? "").trim()
    const csvValue = (csv[field] ?? "").trim()
    if (csvValue && csvValue !== storedValue) {
      next[field] = csvValue
      changedFields.push(field)
    } else {
      next[field] = storedValue
    }
  }
  return { next, changedFields }
}

// Apply a merge result onto a full stored row, preserving every non-metadata
// field (username, github_id, role, and any unknown columns) byte-for-byte.
export function applyMetadataMerge(
  stored: StudentCsvRow,
  next: Record<MetadataField, string>,
): StudentCsvRow {
  return { ...stored, ...next }
}
