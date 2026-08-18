// Which of the three supported upload formats a file is read as. Drives the
// unified upload modal's routing:
//   - roster-csv:     the DEFAULT and the smart one — a structured CSV with a
//                     header row (github_id/username/email + optional
//                     first_name/last_name/name/section/role), or a bare list
//                     whose lines are each read as a handle or an address.
//   - username-list:  a manual override forcing every bare line to a GitHub
//                     handle, even one shaped like an address.
//   - email-list:     a manual override routing every line to an email
//                     invitation, with no columnar reading at all.
//
// There is deliberately no content classifier: Roster CSV is ALWAYS the kind an
// upload opens as, because its parser already handles all three shapes. Guessing
// `email-list` from content would read a bare address list through the flat
// address reader, where per-line shape detection never runs and any columns the
// file carried are discarded. The other two kinds are reachable only by the
// teacher's explicit override.
export type UploadKind = "roster-csv" | "username-list" | "email-list"

export const DEFAULT_UPLOAD_KIND: UploadKind = "roster-csv"
